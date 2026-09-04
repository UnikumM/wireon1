/*
 * Выполнить выражение в живой странице WebView и напечатать результат.
 *
 * Зачем это нужно: Capacitor в релизной сборке почти ничего не пишет в logcat,
 * зато сокет DevTools у WebView открыт. Через него видно и консоль, и
 * исключения, и можно заглянуть в саму страницу — именно так на эмуляторе
 * находились поломки, невидимые снаружи.
 *
 * Перед запуском:
 *   adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>
 *
 * Запуск (расширение .cjs обязательно — package.json объявляет ES-модули):
 *   node scripts/android-eval.cjs "выражение" [таймаут-в-секундах]
 */

const WebSocket = require('ws');
const http = require('http');

const expression = process.argv[2];
const timeoutSec = Number(process.argv[3] || 60);

if (!expression) {
  console.error('нужно выражение первым аргументом');
  process.exit(2);
}

function pages() {
  return new Promise((resolve, reject) => {
    http
      .get('http://127.0.0.1:9333/json', (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

(async () => {
  const list = await pages();
  const page = list.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
  if (!page) {
    console.error('страница не найдена; проверьте adb forward');
    process.exit(3);
  }

  const socket = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  const timer = setTimeout(() => {
    console.error(`ответа нет ${timeoutSec} с`);
    process.exit(4);
  }, timeoutSec * 1000);

  socket.on('open', () => {
    socket.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
          timeout: timeoutSec * 1000
        }
      })
    );
  });

  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.id !== 1) return;
    clearTimeout(timer);
    const result = message.result || {};
    if (result.exceptionDetails) {
      console.log(JSON.stringify({ ошибка: result.exceptionDetails.text, подробности: result.result }, null, 2));
    } else {
      console.log(JSON.stringify(result.result && result.result.value, null, 2));
    }
    socket.close();
    process.exit(0);
  });

  socket.on('error', (err) => {
    console.error('сокет: ' + err.message);
    process.exit(5);
  });
})();
