/**
 * Cloudflare Worker для сайта HowToSayDasha.
 *
 * Принимает с сайта заявки («Соберите свой урок») и результаты теста уровня
 * и отправляет их в Telegram-бота. Токен бота хранится только здесь, в секрете
 * BOT_TOKEN, и никогда не попадает в код сайта.
 *
 * Настройки (Cloudflare → Worker → Settings → Variables and Secrets):
 *   BOT_TOKEN        секрет: токен бота от @BotFather
 *   OWNER_CHAT_ID    числовой Telegram ID, куда слать уведомления; если получателей
 *                    несколько, перечислите ID через запятую (123456789,987654321).
 *                    Каждый получатель должен нажать Start в боте
 *   ALLOWED_ORIGINS  адрес сайта, например https://strangehul1-design.github.io
 *                    (несколько адресов через запятую)
 *   SITE_URL         адрес сайта вместе с папкой, откуда берутся файлы по уровням,
 *                    например https://strangehul1-design.github.io/howtosaydasha-enroll
 */

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1'];
const LEVEL_NAMES = { A1: 'Начальный', A2: 'Элементарный', B1: 'Средний', B2: 'Выше среднего', C1: 'Продвинутый' };
const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const DEFAULT_SITE_URL = 'https://strangehul1-design.github.io/howtosaydasha-enroll';

/* Тексты, которые подставятся в личное сообщение ученику. Перед отправкой
   вы увидите их в поле ввода и сможете поправить. */
const hello = name => (name ? `Здравствуйте, ${name}!` : 'Здравствуйте!');
const TEXTS = {
  file: (name, level, link) =>
    `${hello(name)} Это Дарья из HowToSayDasha. Вы прошли тест: у вас уровень ${level}. Подготовила для вас файл с материалами под этот уровень: ${link}`,
  greeting: name =>
    `${hello(name)} Это Дарья из HowToSayDasha. Спасибо, что прошли тест! На какой курс вы хотели бы записаться: детские занятия, индивидуальные, групповые, бизнес-английский или SpeakingClub?`,
};

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const oneLine = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
const multiLine = (s, max) => String(s ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
const intIn = (v, min, max) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
};
const normUser = v => oneLine(v, 80).replace(/^(?:https?:\/\/)?t\.me\//i, '').replace(/^@/, '');

/* ── Результат теста → уведомление с двумя кнопками ── */
function buildTest(b, env) {
  const level = String(b.level ?? '');
  const tg = normUser(b.tg);
  if (!LEVELS.includes(level) || !USERNAME_RE.test(tg)) return null;

  const total = intIn(b.total, 1, 100);
  const score = intIn(b.score, 0, total);
  const name = oneLine(b.name, 40).replace(/[^\p{L}\p{N} '\-]/gu, '').trim();
  const perLevel = LEVELS.map(l => {
    const pair = Array.isArray(b.breakdown?.[l]) ? b.breakdown[l] : [0, 0];
    const t = intIn(pair[1], 0, 50);
    return `${l} ${intIn(pair[0], 0, t)}/${t}`;
  }).join(', ');

  const site = String(env.SITE_URL || DEFAULT_SITE_URL).replace(/\/+$/, '');
  const fileLink = `${site}/materials/${level}.pdf`;
  const chat = `https://t.me/${tg}`;

  const lines = [
    `🧪 <b>@${tg}</b> прошёл(а) тест на уровень <b>${level}</b> (${LEVEL_NAMES[level]})`,
    '',
    `Правильных ответов: ${score} из ${total}`,
    `По уровням: ${perLevel}`,
  ];
  if (name) lines.push(`Имя: ${esc(name)}`);

  return {
    text: lines.join('\n'),
    reply_markup: {
      inline_keyboard: [
        [{ text: `📎 Отправить файл уровня ${level}`, url: `${chat}?text=${encodeURIComponent(TEXTS.file(name, level, fileLink))}` }],
        [{ text: '👋 Приветствие и вопрос о курсе', url: `${chat}?text=${encodeURIComponent(TEXTS.greeting(name))}` }],
      ],
    },
  };
}

/* ── Заявка из конструктора → уведомление ── */
function buildEnroll(b) {
  const details = multiLine(b.details, 3000);
  if (details.length < 10) return null;
  const tg = normUser(b.tg);
  const message = { text: `📝 <b>Новая заявка с сайта</b>\n\n${esc(details)}` };
  if (USERNAME_RE.test(tg)) {
    message.reply_markup = { inline_keyboard: [[{ text: `💬 Написать @${tg}`, url: `https://t.me/${tg}` }]] };
  }
  return message;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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

    let message;
    if (url.pathname === '/test') message = buildTest(body, env);
    else if (url.pathname === '/enroll') message = buildEnroll(body);
    else return json({ ok: false, error: 'not_found' }, 404, cors);
    if (!message) return json({ ok: false, error: 'invalid' }, 400, cors);

    // Получателей может быть несколько: ID через запятую. Достаточно, чтобы дошло хотя бы одному.
    const recipients = String(env.OWNER_CHAT_ID).split(',').map(s => s.trim()).filter(Boolean);
    const delivered = await Promise.all(recipients.map(async chatId => {
      const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, parse_mode: 'HTML', disable_web_page_preview: true, ...message }),
      });
      if (!res.ok) console.error('Telegram error', chatId, res.status, await res.text());
      return res.ok;
    }));
    if (!delivered.some(Boolean)) return json({ ok: false, error: 'telegram' }, 502, cors);
    return json({ ok: true, delivered: delivered.filter(Boolean).length }, 200, cors);
  },
};
