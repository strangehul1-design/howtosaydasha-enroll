// Проверка работы воркера без интернета: node worker/test.mjs
// Запросы к Telegram подменяются заглушкой, токены тут тестовые.
import worker from './worker.js';

const SITE = 'https://strangehul1-design.github.io/howtosaydasha-enroll';
const env = {
  BOT_TOKEN: 'TEST:TOKEN',
  OWNER_CHAT_ID: '12345, 67890',
  ALLOWED_ORIGINS: 'https://strangehul1-design.github.io',
  SITE_URL: SITE + '/',
  SETUP_KEY: 'setup-key',
};
const ORIGIN = 'https://strangehul1-design.github.io';
// пароль вебхука считается из токена бота (тот же алгоритм, что в воркере)
const SECRET = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.BOT_TOKEN}:htsd-webhook-v1`))
  .then(h => [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join(''));

let sent = [];
let failing = new Set();
let failDesc = 'fail';
let jwks = { keys: [] };
let jwksFetches = 0;
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith('jwks.json')) { jwksFetches++; return new Response(JSON.stringify(jwks), { status: 200 }); }
  const method = String(url).split('/').pop();
  sent.push({ method, body: JSON.parse(init.body) });
  if (failing.has(method)) return new Response(JSON.stringify({ ok: false, description: failDesc }), { status: 403 });
  const result = method === 'getMe' ? { username: 'htsd_test_bot', id: 4242 } : method === 'getWebhookInfo' ? { url: 'x', pending_update_count: 0 } : {};
  return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
};
const calls = method => sent.filter(s => s.method === method);
const reset = () => { sent = []; failing = new Set(); failDesc = 'fail'; };

const hook = (update, secret = SECRET, e = env) =>
  worker.fetch(new Request('https://worker.test/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Telegram-Bot-Api-Secret-Token': secret } : {}) },
    body: JSON.stringify(update),
  }), e);
const site = (path, body, { origin = ORIGIN, method = 'POST', raw, e = env } = {}) =>
  worker.fetch(new Request('https://worker.test' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: method === 'POST' ? (raw ?? JSON.stringify(body)) : undefined,
  }), e);

const out = console.log.bind(console);
console.error = console.warn = console.log = () => {}; // логи воркера не засоряют вывод тестов
let failed = 0;
const check = (name, ok, extra = '') => {
  out(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) failed++;
};
const buttons = body => (body?.reply_markup?.inline_keyboard ?? []).flat();

const anna = { id: 111, first_name: 'Анна', username: 'anna_test' };
const startMsg = (payload, from = anna) => ({ message: { message_id: 1, from, chat: { id: from.id, type: 'private' }, text: '/start' + (payload ? ' ' + payload : '') } });

// ───────── ученик нажал Start после теста ─────────
reset();
let r = await hook(startMsg('tB144400'));
let j = await r.json();
check('старт после теста: ответ 200, файл отправлен', r.status === 200 && j.handled === 'test' && j.level === 'B1' && j.score === 12 && j.fileSent === true, JSON.stringify(j));
const doc = calls('sendDocument')[0]?.body;
check('ученику уходит PDF вложением, а не ссылкой в тексте', doc?.chat_id === 111 && doc.document === `${SITE}/materials/howtosaydasha_Rekomendacii_B1.pdf`, JSON.stringify(doc));
check('в подписи к файлу: приветствие, уровень, счёт, без ссылок', doc?.caption.includes('Здравствуйте, Анна!') && doc.caption.includes('B1') && doc.caption.includes('12 из 20') && !/https?:/.test(doc.caption), doc?.caption);
const notes = calls('sendMessage').filter(s => owners().includes(String(s.body.chat_id)));
function owners() { return ['12345', '67890']; }
check('уведомление уходит обоим получателям', notes.length === 2);
const n = notes[0]?.body;
check('«@ник прошёл(а) тест на уровень B1»', n?.text.includes('<b>@anna_test</b> прошёл(а) тест на уровень <b>B1</b> (Средний)'), n?.text);
check('в уведомлении счёт, разбивка и статус файла', n?.text.includes('12 из 20') && n.text.includes('B1 4/4') && n.text.includes('B2 0/4') && n.text.includes('отправлен ученику ✅'), n?.text);
const kb = buttons(n);
check('кнопка 1 отправляет файл (callback)', kb[0]?.callback_data === 'f:111:B1', JSON.stringify(kb));
check('кнопка 2 отправляет приветствие (callback)', kb[1]?.callback_data === 'g:111');
check('кнопка 3 открывает чат с учеником', kb[2]?.url === 'https://t.me/anna_test');
check('все callback_data короче 64 байт', kb.filter(b => b.callback_data).every(b => new TextEncoder().encode(b.callback_data).length <= 64));

// файл подбирается по уровню
const fileFor = async payload => { reset(); await hook(startMsg(payload)); return calls('sendDocument')[0]?.body.document.split('/').pop(); };
check('A1 → файл A1-A2', await fileFor('tA100000') === 'howtosaydasha_Rekomendacii_A1-A2.pdf');
check('A2 → файл A1-A2', await fileFor('tA244000') === 'howtosaydasha_Rekomendacii_A1-A2.pdf');
check('B2 → файл B2', await fileFor('tB244440') === 'howtosaydasha_Rekomendacii_B2.pdf');
check('C1 → файл C1-C2', await fileFor('tC144444') === 'howtosaydasha_Rekomendacii_C1-C2.pdf');

// ученик без юзернейма
reset();
await hook(startMsg('tB144400', { id: 222, first_name: 'Борис <b>' }));
const n2 = calls('sendMessage').find(s => String(s.body.chat_id) === '12345')?.body;
check('без юзернейма: ссылка-упоминание по ID, имя экранировано', n2?.text.includes('<a href="tg://user?id=222">Борис &lt;b&gt;</a>') && buttons(n2)[2]?.url === 'tg://user?id=222', n2?.text);

// не удалось отправить файл
reset(); failing.add('sendDocument');
await hook(startMsg('tB144400'));
const n3 = calls('sendMessage').find(s => String(s.body.chat_id) === '12345')?.body;
check('если файл не ушёл: ученику объяснение, вам предупреждение', calls('sendMessage').some(s => s.body.chat_id === 111 && s.body.text.includes('Не получилось отправить файл')) && n3?.text.includes('⚠️'), n3?.text);

// старт без результата теста
reset();
j = await (await hook(startMsg(''))).json();
check('старт без теста: приветствие со ссылкой на тест, файла нет, вам ничего не уходит', j.handled === 'start' && calls('sendDocument').length === 0 && calls('sendMessage').length === 1 && calls('sendMessage')[0].body.text.includes('/#test'));
reset();
await hook(startMsg('tZ9999999'));
check('подделанный код старта не приводит к отправке файла', calls('sendDocument').length === 0);
reset();
await hook(startMsg('', { id: 12345, first_name: 'Дарья' }));
check('владелец без кода: справка и его ID', calls('sendMessage')[0]?.body.text.includes('12345'));

// ───────── кнопки получателей ─────────
const cbFrom = (data, from, message = { chat: { id: from.id }, message_id: 9 }) => ({ callback_query: { id: 'cb1', from, data, message } });
const dasha = { id: 12345, first_name: 'Дарья' };

reset();
j = await (await hook(cbFrom('f:111:B1', dasha))).json();
check('кнопка «файл»: PDF уходит ученику', j.handled === 'file' && calls('sendDocument')[0]?.body.chat_id === '111' && calls('sendDocument')[0].body.document.endsWith('_B1.pdf'));
check('кнопка «файл»: получатель видит подтверждение', calls('answerCallbackQuery')[0]?.body.text.includes('отправлен'));

reset();
j = await (await hook(cbFrom('g:111', dasha))).json();
const gm = calls('sendMessage')[0]?.body;
check('кнопка «приветствие»: ученику уходит приветствие и вопрос о курсе', gm?.chat_id === '111' && gm.text.includes('Здравствуйте!') && gm.text.includes('На какой курс'), JSON.stringify(gm));
check('…с кнопками выбора курса', buttons(gm).map(b => b.callback_data).join() === 'c:kids,c:individual,c:group,c:business,c:club', JSON.stringify(buttons(gm)));

reset();
j = await (await hook(cbFrom('f:111:B1', { id: 999, first_name: 'Чужой' }))).json();
check('кнопки получателей недоступны посторонним', j.handled === 'denied' && calls('sendDocument').length === 0 && calls('answerCallbackQuery')[0]?.body.text === 'Нет доступа');
reset();
j = await (await hook(cbFrom('f:abc:B1', dasha))).json();
check('неверные данные кнопки отвергаются', calls('sendDocument').length === 0);

// ученик выбрал курс
reset();
j = await (await hook(cbFrom('c:group', anna, { chat: { id: 111 }, message_id: 55 }))).json();
check('выбор курса: ученику благодарность', calls('sendMessage').some(s => s.body.chat_id === 111 && s.body.text.includes('Групповые занятия')));
check('выбор курса: кнопки у ученика убираются', calls('editMessageReplyMarkup')[0]?.body.message_id === 55 && calls('editMessageReplyMarkup')[0].body.reply_markup.inline_keyboard.length === 0);
const cn = calls('sendMessage').filter(s => ['12345', '67890'].includes(String(s.body.chat_id)));
check('выбор курса: обоим получателям «@ник выбрал(а) курс»', cn.length === 2 && cn[0].body.text.includes('<b>@anna_test</b> выбрал(а) курс: <b>Групповые занятия</b>'), cn[0]?.body.text);

// ───────── обычные сообщения ─────────
reset();
await hook({ message: { message_id: 5, from: anna, chat: { id: 111, type: 'private' }, text: 'Подскажите про <скидку>' } });
const fw = calls('sendMessage').filter(s => ['12345', '67890'].includes(String(s.body.chat_id)));
check('сообщение ученика пересылается получателям с кнопкой «Открыть чат»', fw.length === 2 && fw[0].body.text.includes('@anna_test') && fw[0].body.text.includes('Подскажите про &lt;скидку&gt;') && buttons(fw[0]?.body)[0]?.url === 'https://t.me/anna_test', fw[0]?.body.text);
check('ученик видит, что сообщение передано', calls('sendMessage').some(s => s.body.chat_id === 111 && s.body.text.includes('передано')));
reset();
await hook({ message: { message_id: 6, from: anna, chat: { id: 111, type: 'private' }, photo: [{}] } });
check('фото и файлы ученика копируются получателям', calls('copyMessage').length === 2);
reset();
await hook({ message: { message_id: 7, from: dasha, chat: { id: 12345, type: 'private' }, text: 'привет' } });
check('сообщение владельца боту не пересылается самому себе', calls('sendMessage').length === 1 && calls('sendMessage')[0].body.chat_id === 12345 && calls('sendMessage')[0].body.text.includes('Открыть чат'));
reset();
await hook({ message: { message_id: 8, from: anna, chat: { id: 111, type: 'private' }, text: '/id' } });
check('/id подсказывает Telegram ID', calls('sendMessage')[0]?.body.text.includes('<code>111</code>') && calls('sendMessage').length === 1);
reset();
await hook({ message: { message_id: 9, from: anna, chat: { id: -100, type: 'group' }, text: 'в группе' } });
check('сообщения из групп игнорируются', sent.length === 0);

// ───────── защита вебхука и настройка ─────────
reset();
check('вебхук без секрета → 401', (await hook(startMsg('tB144400'), '')).status === 401 && sent.length === 0);
check('вебхук с чужим секретом → 401', (await hook(startMsg('tB144400'), 'wrong')).status === 401 && sent.length === 0);
r = await hook(startMsg('tB144400'), 'legacy', { ...env, WEBHOOK_SECRET: 'legacy' });
check('прежний WEBHOOK_SECRET ещё принимается, если задан', r.status === 200);
check('…а если не задан, не принимается', (await hook(startMsg('tB144400'), 'legacy')).status === 401);
r = await hook(null);
check('сломанный запрос не роняет вебхук (200)', r.status === 200);
check('/setup с неверным ключом → 403', (await site('/setup', {}, { origin: '' , raw: '{}' }).then(x => x.status)) === 403);
reset();
r = await worker.fetch(new Request('https://htsd.example.workers.dev/setup', { method: 'POST', headers: { 'X-Setup-Key': 'setup-key' } }), env);
j = await r.json();
const sw = calls('setWebhook')[0]?.body;
check('/setup: подключает вебхук с секретом и нужными событиями', r.status === 200 && sw?.url === 'https://htsd.example.workers.dev/webhook' && sw.secret_token === SECRET && SECRET.length === 64 && sw.allowed_updates.join() === 'message,callback_query', JSON.stringify(sw));
check('/setup: возвращает имя бота и состояние вебхука', j.bot === 'htsd_test_bot' && j.info.pending === 0, JSON.stringify(j));

// ───────── заявка с сайта ─────────
reset();
r = await site('/enroll', { details: 'Имя: Анна\nПрограмма: Групповые занятия <b>', tg: 'anna_test' });
j = await r.json();
const en = calls('sendMessage');
check('заявка: ответ 200, дошло двоим', r.status === 200 && j.delivered === 2 && en.length === 2, JSON.stringify(j));
check('заявка: текст экранирован, есть кнопка «Написать»', en[0]?.body.text.includes('&lt;b&gt;') && buttons(en[0]?.body)[0]?.url === 'https://t.me/anna_test');
reset();
await site('/enroll', { details: 'Имя: Анна\nСвязь: Почта, a@b.ru' });
check('заявка без Telegram: кнопки нет', !calls('sendMessage')[0]?.body.reply_markup);
reset();
check('чужой сайт → 403', (await site('/enroll', {}, { origin: 'https://evil.example' })).status === 403);
check('без Origin → 403', (await site('/enroll', {}, { origin: '' })).status === 403);
check('пустая заявка → 400', (await site('/enroll', { details: 'x' })).status === 400);
check('битый JSON → 400', (await site('/enroll', null, { raw: '{oops' })).status === 400);
check('слишком большой запрос → 413', (await site('/enroll', null, { raw: JSON.stringify({ details: 'x'.repeat(30000) }) })).status === 413);
check('старый адрес /test больше не принимается → 404', (await site('/test', { level: 'B1', tg: 'anna_test' })).status === 404);
check('неизвестный путь → 404', (await site('/nope', { details: 'x'.repeat(20) })).status === 404);
reset();
r = await site('/enroll', { details: 'x'.repeat(20), website: 'spam' });
check('ловушка для ботов: 200, но в Telegram ничего не уходит', r.status === 200 && sent.length === 0);
r = await site('/enroll', { details: 'x'.repeat(20) }, { e: { ...env, BOT_TOKEN: '' } });
check('нет токена → 500', r.status === 500);
r = await site('/enroll', null, { method: 'OPTIONS' });
check('CORS preflight для своего сайта', r.status === 204 && r.headers.get('Access-Control-Allow-Origin') === ORIGIN);
r = await site('/enroll', null, { method: 'OPTIONS', origin: 'https://evil.example' });
check('CORS preflight для чужого сайта отклонён', r.status === 403 && !r.headers.get('Access-Control-Allow-Origin'));
reset(); failing.add('sendMessage');
const origError = console.error; console.error = () => {};
r = await site('/enroll', { details: 'x'.repeat(20) });
console.error = origError;
check('ошибка Telegram при заявке → 502', r.status === 502);


// ───────── вход через Telegram на сайте (id_token, подпись RS256) ─────────
const genKey = () => crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const rsa = await genKey(), strangerRsa = await genKey();
jwks = { keys: [{ ...(await crypto.subtle.exportKey('jwk', rsa.publicKey)), kid: 'oidc-1', alg: 'RS256' }] };
const b64u = x => Buffer.from(x).toString('base64url');
const jwt = async (claims, { key = rsa.privateKey, header = { alg: 'RS256', kid: 'oidc-1', typ: 'JWT' } } = {}) => {
  const h = b64u(JSON.stringify(header)), p = b64u(JSON.stringify(claims));
  return h + '.' + p + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(h + '.' + p)));
};
const now = Math.floor(Date.now() / 1000);
const claims = (over = {}) => ({ iss: 'https://oauth.telegram.org', aud: 'TEST', sub: '777', iat: now, exp: now + 3600, id: 111, name: 'Анна Петрова', given_name: 'Анна', family_name: 'Петрова', preferred_username: 'anna_test', nonce: 'n-1', ...over });
const login = async (token, over = {}) => site('/login', { id_token: token, nonce: 'n-1', code: 'tB244410', ...over });

reset();
r = await login(await jwt(claims()));
j = await r.json();
const ln = calls('sendMessage').filter(x => ['12345', '67890'].includes(String(x.body.chat_id)));
check('вход через Telegram: ответ 200, уведомление дошло двоим', r.status === 200 && j.delivered === 2 && ln.length === 2, JSON.stringify(j));
check('«@ник прошёл(а) тест на уровень B2», файл ещё не отправлен', ln[0]?.body.text.includes('<b>@anna_test</b> прошёл(а) тест на уровень <b>B2</b> (Выше среднего)') && ln[0].body.text.includes('13 из 20') && ln[0].body.text.includes('Файл ещё не отправлен'), ln[0]?.body.text);
check('файл ученику автоматически НЕ уходит (только по кнопке)', calls('sendDocument').length === 0);
check('кнопки: отправить файл, приветствие, открыть чат', buttons(ln[0]?.body).map(b => b.callback_data || b.url).join() === 'f:111:B2,g:111,https://t.me/anna_test', JSON.stringify(buttons(ln[0]?.body)));
reset();
await login(await jwt(claims({ preferred_username: undefined, given_name: 'Борис <b>' })));
check('без юзернейма: упоминание по ID, имя экранировано', calls('sendMessage')[0]?.body.text.includes('<a href="tg://user?id=111">Борис &lt;b&gt;'), calls('sendMessage')[0]?.body.text);
check('ключи Telegram запрашиваются один раз и кэшируются', jwksFetches === 1, String(jwksFetches));

// подделки и ошибки
const rejected = async (name, token, over = {}) => { reset(); const x = await login(token, over); check(name, x.status === 401 && sent.length === 0, String(x.status)); };
await rejected('токен с чужой подписью отвергается', await jwt(claims(), { key: strangerRsa.privateKey }));
await rejected('токен другого бота (чужой aud) отвергается', await jwt(claims({ aud: '999' })));
await rejected('токен от другого издателя отвергается', await jwt(claims({ iss: 'https://evil.example' })));
await rejected('просроченный токен отвергается', await jwt(claims({ exp: now - 10 })));
await rejected('токен без id пользователя отвергается', await jwt(claims({ id: undefined })));
await rejected('неверный nonce отвергается', await jwt(claims()), { nonce: 'другой' });
await rejected('алгоритм HS256 отвергается', await jwt(claims(), { header: { alg: 'HS256', kid: 'oidc-1' } }));
await rejected('неизвестный ключ (kid) отвергается', await jwt(claims(), { header: { alg: 'RS256', kid: 'нет-такого' } }));
await rejected('мусор вместо токена отвергается', 'abc.def.ghi');
await rejected('пустой токен отвергается', '');
reset();
check('неверный код результата → 400', (await login(await jwt(claims()), { code: 'tZ99999' })).status === 400 && sent.length === 0);
check('вход с чужого сайта → 403', (await site('/login', { id_token: await jwt(claims()), code: 'tB244410' }, { origin: 'https://evil.example' })).status === 403);

// кнопка «файл» для ученика, который не разрешил боту писать
reset(); failing.add('sendDocument'); failDesc = "Forbidden: bot can't initiate conversation with a user";
await hook(cbFrom('f:111:B2', dasha));
check('кнопка «файл»: если ученик не разрешил писать, получатель видит понятную причину', calls('answerCallbackQuery')[0]?.body.text.includes('не разрешил боту писать'), calls('answerCallbackQuery')[0]?.body.text);
reset();
r = await worker.fetch(new Request('https://worker.test/status', { method: 'POST', headers: { 'X-Setup-Key': 'setup-key' } }), env);
j = await r.json();
check('/status: показывает ID бота и состояние вебхука', j.bot_id === 4242 && j.bot === 'htsd_test_bot' && j.webhook.pending === 0 && j.recipients === 2, JSON.stringify(j));
check('/status: без ключа → 403', (await worker.fetch(new Request('https://worker.test/status', { method: 'POST' }), env)).status === 403);

out(failed ? `\nПровалено проверок: ${failed}` : '\nВсе проверки пройдены');
process.exit(failed ? 1 : 0);
