// Мост к WebView эмулятора: выполняет выражение на живой странице и печатает ответ.
const WebSocket = require('ws');
const http = require('http');

function targets() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9333/json', (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  const expression = process.argv[2];
  const list = await targets();
  const page = list.find((t) => t.type === 'page');
  if (!page) { console.error('нет страницы'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  const send = (method, params) =>
    new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });

  const logs = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.consoleAPICalled') {
      logs.push(msg.params.type + ': ' + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      logs.push('EXCEPTION: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
    }
  });

  await new Promise((r) => ws.on('open', r));
  await send('Runtime.enable', {});
  await send('Log.enable', {});
  await new Promise((r) => setTimeout(r, 400));

  const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  console.log('RESULT:', JSON.stringify(out.result?.result?.value ?? out.result?.result?.description ?? out.result));
  if (logs.length) console.log('LOGS:\n' + logs.slice(-25).join('\n'));
  ws.close();
  process.exit(0);
})();
