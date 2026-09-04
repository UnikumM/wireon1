/**
 * Compiles electron/preload.ts as CommonJS and publishes it as
 * dist-electron/preload.cjs.
 *
 * Electron does not support ESM preload scripts (and ignores package.json
 * "type": "module" for preload), so the bridge must ship as a .cjs file while
 * the main process stays ESM.
 */
import { spawn } from 'child_process';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EMITTED = path.join(ROOT, 'dist-electron', 'preload.js');
const TARGET = path.join(ROOT, 'dist-electron', 'preload.cjs');
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const SERVER_ORIGIN_FILE = path.join(ROOT, 'dist-electron', 'server-origin.json');

/**
 * Кладёт рядом с главным процессом источники, к которым окну можно обращаться.
 *
 * Зачем. Окно получает адрес сервера через `import.meta.env` — Vite подставляет
 * его в сборку. Главному процессу это недоступно: он собирается `tsc`, и `.env`
 * к моменту запуска приложения рядом уже нет. А знать источник ему нужно ровно
 * для одного: вписать его в `connect-src` политики безопасности. Наш сервер
 * отвечает по `http` на нестандартном порту, под общее разрешение `https:` он
 * не попадает — и запрос гасился политикой раньше, чем уходил в сеть. Выглядело
 * это как «Failed to fetch», то есть неотличимо от выключенного сервера.
 *
 * Брокер «слушать вместе» живёт на том же сервере, но обращаются к нему по
 * `ws:`, и это **отдельный источник**: разрешение `http://хост` соединение
 * `ws://хост` не покрывает. Ровно на этом комната и оставалась «только на этом
 * устройстве» с подписью «Брокер не ответил» — сокет блокировался политикой, а
 * снаружи это неотличимо от молчащего сервера.
 *
 * Токен сюда не попадает: для политики нужен только источник, а секретам в
 * файле рядом с кодом делать нечего.
 */
function writeServerOrigin() {
  const origins = [];
  for (const name of ['VITE_WIREON_SERVER_URL', 'VITE_WIREON_MQTT_URL']) {
    const raw = (process.env[name] || '').trim() || readFromDotEnv(name);
    if (!raw) continue;
    // Берётся первый из списка: адресов брокера может быть несколько через
    // запятую, но свой у нас один, а публичные и так подходят под `wss:`.
    const first = raw.split(',')[0].trim();
    try {
      const url = new URL(first);
      // Не `url.origin`: у `ws:` он в некоторых движках равен строке `null`.
      // Схема здесь важна сама по себе — под `http://…` соединение `ws://…`
      // не подпадает, это и была поломка.
      const origin = `${url.protocol}//${url.host}`;
      if (!origins.includes(origin)) origins.push(origin);
    } catch {
      console.warn(`[build-preload] ${name} не разбирается как адрес: ${first}`);
    }
  }

  writeFileSync(SERVER_ORIGIN_FILE, JSON.stringify({ origins }, null, 2) + '\n');
  console.log(
    origins.length
      ? `[build-preload] источники для CSP: ${origins.join(' ')}`
      : '[build-preload] адреса не заданы — политика останется строгой'
  );
}

/** Читает `.env` сам: подключать dotenv ради двух строк незачем. */
function readFromDotEnv(key) {
  const file = path.join(ROOT, '.env');
  if (!existsSync(file)) return '';
  const wanted = new RegExp('^\\s*' + key + '\\s*=\\s*(.*)$');
  for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const match = wanted.exec(line);
    if (!match) continue;
    return match[1].trim().replace(/^['"]|['"]$/g, '');
  }
  return '';
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', cwd: ROOT });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function main() {
  const code = await run(process.execPath, [TSC, '-p', 'tsconfig.preload.json']);
  if (code !== 0) {
    throw new Error(`tsc -p tsconfig.preload.json failed with exit code ${code}`);
  }

  if (!existsSync(EMITTED)) {
    throw new Error(`Expected ${path.relative(ROOT, EMITTED)} to be emitted, but it is missing`);
  }

  rmSync(TARGET, { force: true });
  renameSync(EMITTED, TARGET);

  // The bridge is dead weight if it is not really CommonJS: Electron would
  // throw a SyntaxError at preload time and window.electronAPI would vanish.
  const emitted = readFileSync(TARGET, 'utf-8');
  if (!emitted.includes('require(')) {
    throw new Error('preload.cjs does not contain require() — it was not emitted as CommonJS');
  }
  const esmImport = emitted.split(/\r?\n/).find((line) => /^import\s/.test(line));
  if (esmImport) {
    throw new Error(`preload.cjs contains a top-level ESM import: ${esmImport}`);
  }

  console.log(`[build-preload] wrote ${path.relative(ROOT, TARGET)} (CommonJS)`);

  writeServerOrigin();
}

main().catch((err) => {
  console.error(`[build-preload] ${err.message}`);
  process.exit(1);
});
