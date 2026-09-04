/**
 * Наблюдение за консолью, сетью и <audio> внутри WebView Android.
 *
 * Зачем отдельный инструмент: в релизной сборке Capacitor почти ничего не
 * пишет в logcat, и настоящие причины отказов видны только в консоли
 * страницы. Через неё найдены обе поломки 2026-08-28 — отсутствие
 * `navigator.mediaSession` в WebView и падение распаковки yt-dlp на сервере.
 *
 * Как пользоваться:
 *
 *   adb forward tcp:9333 localabstract:webview_devtools_remote_$(adb shell pidof pro.wireon.music)
 *   curl -s http://127.0.0.1:9333/json     # оттуда webSocketDebuggerUrl
 *   node scripts/android-webview-watch.cjs <ws-url> [секунды]
 *
 * Расширение `.cjs` обязательно: package.json объявляет модули ES, а `ws`
 * подключается через require. Запускать из корня проекта — иначе `ws` не
 * найдётся.
 */
const WebSocket = require('ws');

const ws = new WebSocket(process.argv[2], { perMessageDeflate: false });
const seconds = Number(process.argv[3] || 120);

let id = 0;
const send = (method, params) => ws.send(JSON.stringify({ id: ++id, method, params: params || {} }));

const PROBE = `(() => {
  const list = Array.from(document.querySelectorAll('audio'));
  return JSON.stringify(list.map(a => ({
    t: Math.round(a.currentTime * 10) / 10,
    d: Math.round(a.duration * 10) / 10 || 0,
    paused: a.paused,
    ready: a.readyState,
    net: a.networkState,
    err: a.error ? a.error.code + ':' + (a.error.message || '').slice(0, 60) : null,
    buf: a.buffered.length ? Math.round(a.buffered.end(a.buffered.length - 1)) : 0,
    src: (a.currentSrc || '').slice(0, 40)
  })));
})()`;

ws.on('open', () => {
  send('Runtime.enable');
  send('Log.enable');
  send('Network.enable');
  console.log('[watch] подключено');

  const started = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - started > seconds * 1000) {
      clearInterval(timer);
      console.log('[watch] конец');
      process.exit(0);
    }
    ws.send(JSON.stringify({
      id: 100000,
      method: 'Runtime.evaluate',
      params: { expression: PROBE, returnByValue: true }
    }));
  }, 3000);
});

const text = (args) =>
  (args || []).map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' ');

const stamp = () => new Date().toISOString().slice(14, 19);

ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }

  if (msg.id === 100000) {
    const v = msg.result && msg.result.result && msg.result.result.value;
    if (v && v !== '[]') console.log(`${stamp()} audio ${v}`);
    return;
  }

  const m = msg.method;
  if (m === 'Runtime.consoleAPICalled') {
    const t = text(msg.params.args);
    if (!/CapacitorHttp fetch/.test(t)) console.log(`${stamp()} [${msg.params.type}] ${t}`.slice(0, 260));
  } else if (m === 'Log.entryAdded') {
    console.log(`${stamp()} [log.${msg.params.entry.level}] ${msg.params.entry.text}`.slice(0, 200));
  } else if (m === 'Network.responseReceived') {
    const r = msg.params.response;
    if (/sndcdn|videoplayback|v1\/stream/.test(r.url)) {
      console.log(`${stamp()} [сеть ${r.status}] ${r.url.slice(0, 60)}`);
    }
  } else if (m === 'Network.loadingFailed') {
    console.log(`${stamp()} [обрыв] ${msg.params.errorText} canceled=${msg.params.canceled} type=${msg.params.type}`);
  }
});

ws.on('error', (e) => { console.log('ошибка:', e.message); process.exit(1); });
