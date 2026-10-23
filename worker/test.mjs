// Проверка работы воркера без интернета: node worker/test.mjs
// Запросы к Telegram подменяются заглушкой, токен тут тестовый.
import worker from './worker.js';

const env = {
  BOT_TOKEN: 'TEST:TOKEN',
  OWNER_CHAT_ID: '12345',
  ALLOWED_ORIGINS: 'https://strangehul1-design.github.io',
  SITE_URL: 'https://strangehul1-design.github.io/howtosaydasha-enroll/',
  SETUP_KEY: 'setup-key',
};
const ORIGIN = 'https://strangehul1-design.github.io';

let sent = [];
let telegramOk = true;
globalThis.fetch = async (url, init) => {
  sent.push({ url: String(url), body: JSON.parse(init.body) });
  const method = String(url).split('/').pop();
  const result = method === 'getMe' ? { username: 'htsd_test_bot' } : method === 'getWebhookInfo' ? { url: '', pending_update_count: 0 } : {};
  return new Response(telegramOk ? JSON.stringify({ ok: true, result }) : '{"ok":false}', { status: telegramOk ? 200 : 400 });
};

const call = (path, body, { origin = ORIGIN, method = 'POST', raw } = {}) =>
  worker.fetch(new Request('https://worker.test' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: method === 'POST' ? (raw ?? JSON.stringify(body)) : undefined,
  }), env);

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) failed++;
};

const testBody = {
  name: 'Анна', tg: '@anna_test', level: 'B1', score: 11, total: 20,
  breakdown: { A1: [4, 4], A2: [4, 4], B1: [3, 4], B2: [0, 4], C1: [0, 4] },
};

// 1. результат теста → уведомление и две кнопки
sent = [];
let r = await call('/test', testBody);
check('тест: ответ 200', r.status === 200, r.status);
const m = sent[0]?.body;
check('тест: отправлено в Telegram владельцу', sent[0]?.url === 'https://api.telegram.org/botTEST:TOKEN/sendMessage' && m?.chat_id === '12345');
check('тест: текст «@аккаунт прошёл(а) тест на уровень B1»', m?.text.includes('<b>@anna_test</b> прошёл(а) тест на уровень <b>B1</b>'), m?.text);
check('тест: есть счёт и разбивка по уровням', m?.text.includes('11 из 20') && m?.text.includes('B1 3/4'));
const kb = m?.reply_markup?.inline_keyboard.flat() ?? [];
check('тест: ровно две кнопки', kb.length === 2, kb.length);
const fileUrl = new URL(kb[0].url);
check('кнопка 1: открывает личку ученика', fileUrl.origin + fileUrl.pathname === 'https://t.me/anna_test');
const fileText = fileUrl.searchParams.get('text');
check('кнопка 1: в тексте короткая ссылка на файл уровня и имя ученика', fileText.includes('https://clck.ru/3WeZqH') && !fileText.includes('materials/') && fileText.includes('Анна'), fileText);
check('сообщение с файлом короткое (ссылка 22 символа, а не 100)', fileText.length < 240, String(fileText.length));

// файл подбирается по уровню: A1 и A2 делят один файл, C1 получает файл C1–C2
const fileFor = async level => {
  sent = [];
  await call('/test', { ...testBody, level });
  return new URL(sent[0].body.reply_markup.inline_keyboard[0][0].url).searchParams.get('text').match(/https:\/\/clck\.ru\/(\w+)/)?.[1];
};
check('файл для A1 → A1-A2', await fileFor('A1') === '3WedwX');
check('файл для A2 → A1-A2 (тот же)', await fileFor('A2') === '3WedwX');
check('файл для B1 → B1', await fileFor('B1') === '3WeZqH');
check('файл для B2 → B2', await fileFor('B2') === '3Wedwk');
check('файл для C1 → C1-C2', await fileFor('C1') === '3Wedwt');
sent = [];
const greetUrl = new URL(kb[1].url);
const greetText = greetUrl.searchParams.get('text');
check('кнопка 2: личка ученика + приветствие и вопрос про курс', greetUrl.pathname === '/anna_test' && greetText.includes('Здравствуйте, Анна!') && greetText.includes('На какой курс'), greetText);
check('кнопки: длина ссылки до 2000 символов', kb.every(b => b.url.length < 2000), kb.map(b => b.url.length).join());

// 2. заявка из конструктора
sent = [];
r = await call('/enroll', { details: 'Имя: Анна\nПрограмма: Групповые занятия <b>', tg: 'anna_test' });
check('заявка: ответ 200', r.status === 200);
check('заявка: текст экранирован', sent[0]?.body.text.includes('&lt;b&gt;') && !sent[0].body.text.includes('<b>Анна'));
check('заявка: кнопка «Написать» при Telegram-контакте', sent[0]?.body.reply_markup?.inline_keyboard[0][0].url === 'https://t.me/anna_test');
sent = [];
await call('/enroll', { details: 'Имя: Анна\nСвязь: Почта, a@b.ru' });
check('заявка: без Telegram кнопки нет', !sent[0]?.body.reply_markup);

// 3. защита
sent = [];
check('чужой сайт → 403', (await call('/test', testBody, { origin: 'https://evil.example' })).status === 403);
check('без Origin → 403', (await call('/test', testBody, { origin: '' })).status === 403);
check('плохой уровень → 400', (await call('/test', { ...testBody, level: 'Z9' })).status === 400);
check('плохой username → 400', (await call('/test', { ...testBody, tg: 'ab' })).status === 400);
check('битый JSON → 400', (await call('/test', null, { raw: '{oops' })).status === 400);
check('слишком большой запрос → 413', (await call('/enroll', null, { raw: JSON.stringify({ details: 'x'.repeat(30000) }) })).status === 413);
check('неизвестный путь → 404', (await call('/nope', testBody)).status === 404);
r = await call('/test', { ...testBody, website: 'spam' });
check('ловушка для ботов: 200, но в Telegram ничего не уходит', r.status === 200 && sent.length === 0);
r = await worker.fetch(new Request('https://worker.test/test', { method: 'POST', headers: { Origin: ORIGIN }, body: JSON.stringify(testBody) }), { ...env, BOT_TOKEN: '' });
check('нет токена → 500 not_configured', r.status === 500);

// 3б. несколько получателей
sent = [];
r = await worker.fetch(new Request('https://worker.test/test', { method: 'POST', headers: { Origin: ORIGIN }, body: JSON.stringify(testBody) }), { ...env, OWNER_CHAT_ID: '12345, 67890' });
check('два получателя: уведомление уходит обоим', r.status === 200 && sent.map(s => s.body.chat_id).join() === '12345,67890', sent.map(s => s.body.chat_id).join());

// 3в. служебные запросы владельца
const admin = (path, key = 'setup-key') => worker.fetch(new Request('https://worker.test' + path, { method: 'POST', headers: key ? { 'X-Setup-Key': key } : {} }), env);
sent = [];
r = await admin('/status');
let st = await r.json();
check('/status: имя бота, число получателей, вебхук не задан', r.status === 200 && st.bot === 'htsd_test_bot' && st.recipients === 1 && st.webhook.url === null, JSON.stringify(st));
check('/status ничего не меняет в Telegram', !sent.some(s => s.url.endsWith('deleteWebhook')));
sent = [];
r = await admin('/setup');
check('/setup: отключает вебхук прежней версии', r.status === 200 && sent.some(s => s.url.endsWith('/deleteWebhook') && s.body.drop_pending_updates === true));
check('/status без ключа → 403', (await admin('/status', '')).status === 403);
check('/setup с неверным ключом → 403', (await admin('/setup', 'wrong')).status === 403);
check('адреса /webhook больше нет → 404', (await call('/webhook', {})).status === 404);

// 4. CORS и ошибка Telegram
r = await call('/test', null, { method: 'OPTIONS' });
check('CORS preflight для своего сайта', r.status === 204 && r.headers.get('Access-Control-Allow-Origin') === ORIGIN);
r = await call('/test', null, { method: 'OPTIONS', origin: 'https://evil.example' });
check('CORS preflight для чужого сайта отклонён', r.status === 403 && !r.headers.get('Access-Control-Allow-Origin'));
telegramOk = false;
const origError = console.error; console.error = () => {};
r = await call('/test', testBody);
console.error = origError;
check('ошибка Telegram → 502', r.status === 502);

console.log(failed ? `\nПровалено проверок: ${failed}` : '\nВсе проверки пройдены');
process.exit(failed ? 1 : 0);
