/**
 * Cloudflare Worker для сайта HowToSayDasha.
 *
 * Делает две вещи:
 *  1. Принимает с сайта заявки («Соберите свой урок») и пересылает их в Telegram.
 *  2. Работает как «мозг» бота: ученик проходит тест на сайте, нажимает Start в боте,
 *     и бот сам присылает ему PDF с рекомендациями для его уровня, а вам отправляет
 *     уведомление «@ник прошёл(а) тест на уровень …» с двумя кнопками.
 *
 * Токен бота хранится только здесь, в секретах Cloudflare, и никогда не попадает в код сайта.
 *
 * Настройки (Cloudflare → Worker → Settings → Variables and Secrets):
 *   BOT_TOKEN        секрет: токен бота от @BotFather
 *   OWNER_CHAT_ID    секрет: числовой Telegram ID получателей уведомлений, несколько
 *                    через запятую (123456789,987654321). Каждый должен нажать Start в боте
 *   SETUP_KEY        секрет: ключ для настройки и диагностики (POST /setup, POST /status)
 *   LOGIN_CLIENT_ID  необязательно: Client ID из BotFather → Login Widget, если он отличается
 *                    от ID бота (по умолчанию берётся число из токена до двоеточия)
 *   ALLOWED_ORIGINS  адрес сайта, например https://strangehul1-design.github.io
 *   SITE_URL         адрес сайта вместе с папкой, откуда берутся PDF,
 *                    например https://strangehul1-design.github.io/howtosaydasha-enroll
 */

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1'];
const LEVEL_NAMES = { A1: 'Начальный', A2: 'Элементарный', B1: 'Средний', B2: 'Выше среднего', C1: 'Продвинутый' };
const QUESTIONS_PER_LEVEL = 4;
const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const DEFAULT_SITE_URL = 'https://strangehul1-design.github.io/howtosaydasha-enroll';

/* Файл с рекомендациями для каждого уровня (лежат в папке materials/ репозитория).
   Для A1 и A2, как и для C1, файл общий. Чтобы заменить файл, положите новый
   с тем же именем или поправьте имя здесь. */
const LEVEL_FILES = {
  A1: 'howtosaydasha_Rekomendacii_A1-A2.pdf',
  A2: 'howtosaydasha_Rekomendacii_A1-A2.pdf',
  B1: 'howtosaydasha_Rekomendacii_B1.pdf',
  B2: 'howtosaydasha_Rekomendacii_B2.pdf',
  C1: 'howtosaydasha_Rekomendacii_C1-C2.pdf',
};

const COURSES = {
  kids: 'Детские занятия',
  individual: 'Индивидуальные занятия',
  group: 'Групповые занятия',
  business: 'Бизнес-английский',
  club: 'SpeakingClub',
};

/* Тексты, которые бот отправляет ученикам. Правьте под себя. */
const TEXTS = {
  welcomeWithFile: (first, level, score, total) =>
    `Здравствуйте${first ? ', ' + first : ''}! 👋 Вы прошли тест на сайте HowToSayDasha: ваш уровень ${level} (${LEVEL_NAMES[level]}), ${score} из ${total}.\n\n` +
    'В файле персональные рекомендации для вашего уровня. Есть вопросы? Напишите их прямо здесь, я передам Дарье.',
  fileCaption: level => `Персональные рекомендации для уровня ${level}`,
  fileFailed: 'Не получилось отправить файл. Дарья пришлёт его вручную, она уже получила ваш результат.',
  greeting: 'Здравствуйте! Это Дарья из HowToSayDasha 👋 Спасибо, что прошли тест. На какой курс вы хотели бы записаться?',
  courseChosen: course => `Принято: ${course}. Дарья напишет вам в Telegram в ближайшее время.`,
  forwarded: 'Сообщение передано Дарье.',
  startPlain: site => `Здравствуйте! Это бот школы HowToSayDasha. Пройдите тест уровня на сайте: ${site}/#test. Бот пришлёт файл с рекомендациями для вашего уровня. Есть вопросы? Напишите их здесь, я передам Дарье.`,
  ownerHelp: 'Это бот школы. Сюда приходят результаты тестов и заявки с сайта, а также сообщения учеников. Чтобы ответить ученику, нажмите «Открыть чат» под его сообщением.',
};

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const oneLine = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
const multiLine = (s, max) => String(s ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
const normUser = v => oneLine(v, 80).replace(/^(?:https?:\/\/)?t\.me\//i, '').replace(/^@/, '');

const owners = env => String(env.OWNER_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);
const isOwner = (env, id) => owners(env).includes(String(id));
const siteUrl = env => String(env.SITE_URL || DEFAULT_SITE_URL).replace(/\/+$/, '');
const fileUrl = (env, level) => `${siteUrl(env)}/materials/${LEVEL_FILES[level]}`;

/* Пароль, которым Telegram подписывает свои запросы к воркеру. Он считается из токена бота,
   поэтому не нужен отдельный секрет и он всегда одинаков при повторной настройке. */
async function webhookSecret(env) {
  const bytes = new TextEncoder().encode(`${env.BOT_TOKEN}:htsd-webhook-v1`);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ── Telegram ── */
async function tg(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) console.error('Telegram error', method, res.status, JSON.stringify(data));
  return { ok: res.ok, data };
}
const say = (env, chat_id, text, extra = {}) =>
  tg(env, 'sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
const notifyOwners = (env, text, reply_markup) =>
  Promise.all(owners(env).map(id => say(env, id, text, reply_markup ? { reply_markup } : {})));

const fullName = u => [u.first_name, u.last_name].filter(Boolean).join(' ');
const who = u => (u.username ? `@${esc(u.username)}` : `<a href="tg://user?id=${u.id}">${esc(fullName(u) || 'Ученик')}</a>`);
const chatButton = u => ({ text: '💬 Открыть чат', url: u.username ? `https://t.me/${u.username}` : `tg://user?id=${u.id}` });
const courseKeyboard = () => {
  const rows = []; const keys = Object.keys(COURSES);
  for (let i = 0; i < keys.length; i += 2) rows.push(keys.slice(i, i + 2).map(k => ({ text: COURSES[k], callback_data: `c:${k}` })));
  return { inline_keyboard: rows };
};

/* Уведомление получателям: «@ник прошёл(а) тест на уровень …» с кнопками.
   fileStatus: true — файл уже отправлен ученику, false — не удалось, null — ещё не отправлялся. */
function notifyTest(env, student, level, counts, fileStatus) {
  const score = counts.reduce((a, b) => a + b, 0);
  const total = LEVELS.length * QUESTIONS_PER_LEVEL;
  const perLevel = LEVELS.map((l, i) => `${l} ${counts[i]}/${QUESTIONS_PER_LEVEL}`).join(', ');
  const status = fileStatus === true ? 'Файл с рекомендациями отправлен ученику ✅'
    : fileStatus === false ? '⚠️ Файл ученику отправить не удалось, отправьте его вручную'
    : 'Файл ещё не отправлен: нажмите кнопку ниже.';
  return notifyOwners(env, [
    `🧪 <b>${who(student)}</b> прошёл(а) тест на уровень <b>${level}</b> (${LEVEL_NAMES[level]})`,
    '',
    `Правильных ответов: ${score} из ${total}`,
    `По уровням: ${perLevel}`,
    status,
  ].join('\n'), {
    inline_keyboard: [
      [{ text: fileStatus === true ? `📎 Отправить файл уровня ${level} ещё раз` : `📎 Отправить файл уровня ${level}`, callback_data: `f:${student.id}:${level}` }],
      [{ text: '👋 Приветствие и вопрос о курсе', callback_data: `g:${student.id}` }],
      [chatButton(student)],
    ],
  });
}

/* ── Вход через Telegram на сайте: проверка id_token ── */
const JWKS_URL = 'https://oauth.telegram.org/.well-known/jwks.json';
let jwksCache = { at: 0, keys: [] };
const b64urlBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), c => c.charCodeAt(0));
const b64urlJson = s => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function signingKey(kid) {
  let jwk = Date.now() - jwksCache.at < 3600e3 && jwksCache.keys.find(k => k.kid === kid);
  if (!jwk) {
    const res = await fetch(JWKS_URL);
    if (!res.ok) throw new Error('jwks unavailable');
    jwksCache = { at: Date.now(), keys: (await res.json()).keys || [] };
    jwk = jwksCache.keys.find(k => k.kid === kid);
  }
  if (!jwk || jwk.kty !== 'RSA') throw new Error('unknown key');
  return crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}

/* Проверяет подпись Telegram, издателя, получателя (наш бот), срок действия и nonce. */
async function verifyIdToken(env, token, nonce) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('bad format');
  const header = b64urlJson(parts[0]);
  if (header.alg !== 'RS256') throw new Error('unsupported alg');
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', await signingKey(header.kid), b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new Error('bad signature');
  const claims = b64urlJson(parts[1]);
  const audience = String(env.LOGIN_CLIENT_ID || String(env.BOT_TOKEN).split(':')[0]);
  if (claims.iss !== 'https://oauth.telegram.org') throw new Error('bad issuer');
  if (String(claims.aud) !== audience) throw new Error('bad audience');
  if (!claims.exp || claims.exp * 1000 < Date.now()) throw new Error('expired');
  if (claims.nonce && claims.nonce !== nonce) throw new Error('bad nonce');
  if (!Number.isSafeInteger(Number(claims.id))) throw new Error('no user id');
  return claims;
}

/* ── Бот: /start из ссылки после теста ── */
async function onStart(env, msg, payload) {
  const student = msg.from, chat = msg.chat.id;
  const m = /^t(A1|A2|B1|B2|C1)([0-4]{5})$/.exec(payload || '');

  if (!m) {
    if (isOwner(env, student.id)) await say(env, chat, `${TEXTS.ownerHelp}\n\nВаш Telegram ID: <code>${student.id}</code>`);
    else await say(env, chat, esc(TEXTS.startPlain(siteUrl(env))));
    return { handled: 'start' };
  }

  const level = m[1];
  const counts = [...m[2]].map(Number);
  const score = counts.reduce((a, b) => a + b, 0);
  const total = LEVELS.length * QUESTIONS_PER_LEVEL;

  // файл уходит ученику вложением: Telegram сам скачивает его по ссылке
  const sent = await tg(env, 'sendDocument', {
    chat_id: chat, document: fileUrl(env, level), parse_mode: 'HTML',
    caption: esc(TEXTS.welcomeWithFile(student.first_name || '', level, score, total)),
  });
  if (!sent.ok) await say(env, chat, esc(TEXTS.fileFailed));

  await notifyTest(env, student, level, counts, sent.ok);
  return { handled: 'test', level, score, fileSent: sent.ok };
}

/* ── Бот: обычные сообщения ── */
async function onMessage(env, msg) {
  if (!msg?.from || msg.from.is_bot || msg.chat?.type !== 'private') return { handled: 'ignored' };
  const text = msg.text || '';
  const start = /^\/start(?:@\w+)?(?:\s+(\S+))?/.exec(text);
  if (start) return onStart(env, msg, start[1]);

  if (/^\/id(?:@\w+)?(?:\s|$)/.test(text)) {
    await say(env, msg.chat.id, `Ваш Telegram ID: <code>${msg.from.id}</code>`);
    return { handled: 'id' };
  }
  if (isOwner(env, msg.from.id)) {
    await say(env, msg.chat.id, esc(TEXTS.ownerHelp));
    return { handled: 'owner-text' };
  }

  // сообщение ученика уходит вам
  const head = `💬 <b>${who(msg.from)}</b> пишет:`;
  const keyboard = { inline_keyboard: [[chatButton(msg.from)]] };
  if (text) {
    await notifyOwners(env, `${head}\n\n${esc(multiLine(text, 3500))}`, keyboard);
  } else {
    await notifyOwners(env, `${head} (не текст, копия ниже)`, keyboard);
    await Promise.all(owners(env).map(id => tg(env, 'copyMessage', { chat_id: id, from_chat_id: msg.chat.id, message_id: msg.message_id })));
  }
  await say(env, msg.chat.id, esc(TEXTS.forwarded));
  return { handled: 'forwarded' };
}

/* ── Бот: нажатия кнопок ── */
async function onCallback(env, cb) {
  const [kind, a, b] = String(cb.data || '').split(':');
  const answer = (text) => tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text });

  // выбор курса учеником
  if (kind === 'c' && COURSES[a]) {
    await answer('Спасибо!');
    if (cb.message) await tg(env, 'editMessageReplyMarkup', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
    await say(env, cb.from.id, esc(TEXTS.courseChosen(COURSES[a])));
    await notifyOwners(env, `📝 <b>${who(cb.from)}</b> выбрал(а) курс: <b>${esc(COURSES[a])}</b>`, { inline_keyboard: [[chatButton(cb.from)]] });
    return { handled: 'course', course: a };
  }

  // кнопки под уведомлением доступны только получателям
  if (!isOwner(env, cb.from.id)) { await answer('Нет доступа'); return { handled: 'denied' }; }

  // Telegram не даёт боту писать тому, кто не разрешил этого (не нажал Start и не дал право при входе на сайте)
  const whyFailed = r => (/can't initiate|bot was blocked|chat not found|user is deactivated/i.test(JSON.stringify(r.data))
    ? 'Ученик не разрешил боту писать. Нажмите «Открыть чат» и напишите ему сами.'
    : 'Не получилось отправить, попробуйте ещё раз.');

  if (kind === 'f' && /^\d+$/.test(a) && LEVELS.includes(b)) {
    const sent = await tg(env, 'sendDocument', { chat_id: a, document: fileUrl(env, b), caption: TEXTS.fileCaption(b) });
    await answer(sent.ok ? 'Файл отправлен ✅' : whyFailed(sent));
    return { handled: 'file', fileSent: sent.ok };
  }
  if (kind === 'g' && /^\d+$/.test(a)) {
    const sent = await say(env, a, esc(TEXTS.greeting), { reply_markup: courseKeyboard() });
    await answer(sent.ok ? 'Приветствие отправлено ✅' : whyFailed(sent));
    return { handled: 'greeting', sent: sent.ok };
  }
  await answer('Неизвестная кнопка');
  return { handled: 'unknown' };
}

/* ── Заявка из конструктора → уведомление ── */
function buildEnroll(b) {
  const details = multiLine(b.details, 3000);
  if (details.length < 10) return null;
  const tgUser = normUser(b.tg);
  const message = { text: `📝 <b>Новая заявка с сайта</b>\n\n${esc(details)}` };
  if (USERNAME_RE.test(tgUser)) {
    message.reply_markup = { inline_keyboard: [[{ text: `💬 Написать @${tgUser}`, url: `https://t.me/${tgUser}` }]] };
  }
  return message;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // запросы от Telegram (без Origin, подписаны секретом)
    if (request.method === 'POST' && url.pathname === '/webhook') {
      const given = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
      // принимаем и пароль из токена, и прежний WEBHOOK_SECRET (если он ещё задан)
      const valid = !!env.BOT_TOKEN && !!given && (given === await webhookSecret(env) || given === env.WEBHOOK_SECRET);
      if (!valid) {
        console.warn('webhook rejected: wrong or missing secret');
        return json({ ok: false, error: 'forbidden' }, 401);
      }
      try {
        const update = await request.json();
        const result = update.callback_query ? await onCallback(env, update.callback_query) : await onMessage(env, update.message);
        console.log('webhook', JSON.stringify(result));
        return json({ ok: true, ...result });
      } catch (e) {
        console.error('webhook error', e && e.stack || e);
        return json({ ok: true, handled: 'error' }); // 200, чтобы Telegram не повторял запрос бесконечно
      }
    }

    // разовая настройка: подключает бота к воркеру
    if (request.method === 'POST' && url.pathname === '/setup') {
      if (!env.SETUP_KEY || request.headers.get('X-Setup-Key') !== env.SETUP_KEY) return json({ ok: false, error: 'forbidden' }, 403);
      if (!env.BOT_TOKEN) return json({ ok: false, error: 'not_configured' }, 500);
      const hook = `${url.origin}/webhook`;
      const set = await tg(env, 'setWebhook', { url: hook, secret_token: await webhookSecret(env), allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
      const me = await tg(env, 'getMe', {});
      const info = await tg(env, 'getWebhookInfo', {});
      const i = info.data.result || {};
      return json({ ok: set.ok, webhook: hook, bot: me.data.result?.username || null,
        info: { url: i.url, pending: i.pending_update_count, last_error: i.last_error_message || null } });
    }

    // диагностика: что видит Telegram (ничего не меняет)
    if (request.method === 'POST' && url.pathname === '/status') {
      if (!env.SETUP_KEY || request.headers.get('X-Setup-Key') !== env.SETUP_KEY) return json({ ok: false, error: 'forbidden' }, 403);
      const me = await tg(env, 'getMe', {});
      const info = await tg(env, 'getWebhookInfo', {});
      const i = info.data.result || {};
      return json({
        ok: true,
        bot: me.data.result?.username || null,
        bot_id: me.data.result?.id ?? null,
        recipients: owners(env).length,
        secrets: { BOT_TOKEN: !!env.BOT_TOKEN, OWNER_CHAT_ID: !!env.OWNER_CHAT_ID },
        webhook: {
          url: i.url || null,
          pending: i.pending_update_count ?? null,
          last_error_at: i.last_error_date ? new Date(i.last_error_date * 1000).toISOString() : null,
          last_error: i.last_error_message || null,
          allowed_updates: i.allowed_updates || null,
        },
      });
    }

    // заявки с сайта
    const origin = request.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
    const originOk = allowed.includes(origin);
    const cors = originOk ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' };

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: originOk ? 204 : 403,
        headers: originOk ? { ...cors, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } : cors,
      });
    }
    if (request.method === 'GET' && url.pathname === '/') return json({ ok: true, service: 'howtosaydasha-notify' }, 200, cors);
    if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405, cors);
    if (!originOk) return json({ ok: false, error: 'origin' }, 403, cors);
    if (!env.BOT_TOKEN || !env.OWNER_CHAT_ID) return json({ ok: false, error: 'not_configured' }, 500, cors);

    let body;
    try {
      const raw = await request.text();
      if (raw.length > 20000) return json({ ok: false, error: 'too_large' }, 413, cors);
      body = JSON.parse(raw);
    } catch {
      return json({ ok: false, error: 'bad_json' }, 400, cors);
    }
    if (!body || typeof body !== 'object') return json({ ok: false, error: 'bad_json' }, 400, cors);
    if (body.website) return json({ ok: true }, 200, cors); // скрытое поле-ловушка для ботов

    // результат теста: ученик вошёл через Telegram на сайте и разрешил боту писать ему
    if (url.pathname === '/login') {
      const m = /^t(A1|A2|B1|B2|C1)([0-4]{5})$/.exec(String(body.code ?? ''));
      if (!m) return json({ ok: false, error: 'invalid' }, 400, cors);
      let claims;
      try {
        claims = await verifyIdToken(env, body.id_token, body.nonce);
      } catch (e) {
        console.warn('login rejected:', e.message);
        return json({ ok: false, error: 'auth' }, 401, cors);
      }
      const student = {
        id: Number(claims.id),
        first_name: oneLine(claims.given_name || claims.name, 64),
        last_name: oneLine(claims.family_name, 64),
        username: USERNAME_RE.test(String(claims.preferred_username || '')) ? claims.preferred_username : '',
      };
      const results = await notifyTest(env, student, m[1], [...m[2]].map(Number), null);
      const delivered = results.filter(r => r.ok).length;
      if (!delivered) return json({ ok: false, error: 'telegram' }, 502, cors);
      return json({ ok: true, delivered }, 200, cors);
    }

    if (url.pathname !== '/enroll') return json({ ok: false, error: 'not_found' }, 404, cors);
    const message = buildEnroll(body);
    if (!message) return json({ ok: false, error: 'invalid' }, 400, cors);

    const results = await notifyOwners(env, message.text, message.reply_markup);
    const delivered = results.filter(r => r.ok).length;
    if (!delivered) return json({ ok: false, error: 'telegram' }, 502, cors);
    return json({ ok: true, delivered }, 200, cors);
  },
};
