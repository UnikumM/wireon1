import { createServer } from 'vite';
import { spawn } from 'child_process';
import { watch } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import electron from 'electron';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESTART_DEBOUNCE_MS = 250;
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

/** Runs a command to completion, resolving its exit code. */
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', cwd: ROOT });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** Compiles the main process and the CommonJS preload bundle. Throws on failure. */
async function compileElectron() {
  const main = await run(process.execPath, [TSC, '-p', 'tsconfig.electron.json']);
  if (main !== 0) {
    throw new Error(`main process compile failed (tsc exit code ${main})`);
  }
  const preload = await run(process.execPath, [path.join(ROOT, 'scripts', 'build-preload.mjs')]);
  if (preload !== 0) {
    throw new Error(`preload compile failed (exit code ${preload})`);
  }
}

async function start() {
  console.log('⚡ [1/3] Compiling Electron main process + preload...');
  try {
    await compileElectron();
  } catch (err) {
    console.error(`❌ ${err.message}`);
    console.error('   Electron was not started — fix the TypeScript errors above.');
    process.exit(1);
  }

  console.log('🚀 [2/3] Starting Vite dev server...');
  const server = await createServer({
    configFile: './vite.config.ts',
    mode: 'development',
  });
  await server.listen();

  const address = server.httpServer?.address();
  const port = typeof address === 'object' && address ? address.port : 3000;
  const url = `http://localhost:${port}`;
  console.log(`🌐 [3/3] Launching Wireon Desktop Window -> ${url}`);

  let electronProcess = null;
  let restarting = false;

  const launchElectron = () => {
    let replaced = false;
    const env = { ...process.env, VITE_DEV_SERVER_URL: url };
    // Inherited from Electron-based editors (VS Code): it would make the binary
    // boot as plain Node — no window and no Electron API.
    delete env.ELECTRON_RUN_AS_NODE;

    const child = spawn(electron, ['.'], {
      stdio: 'inherit',
      cwd: ROOT,
      env,
    });

    child.on('error', (err) => {
      console.error('❌ Failed to spawn Electron:', err.message);
      server.close();
      process.exit(1);
    });

    child.on('close', (code) => {
      if (replaced) return;
      server.close();
      process.exit(code ?? 0);
    });

    child.markReplaced = () => {
      replaced = true;
    };
    return child;
  };

  electronProcess = launchElectron();

  const restart = async () => {
    if (restarting) return;
    restarting = true;
    try {
      console.log('♻️  electron/ changed — recompiling main process + preload...');
      await compileElectron();
    } catch (err) {
      console.error(`❌ ${err.message}`);
      console.error('   Electron was not restarted — the previous build is still running.');
      restarting = false;
      return;
    }

    const previous = electronProcess;
    if (previous) {
      previous.markReplaced();
      await new Promise((resolve) => {
        if (previous.exitCode !== null || previous.signalCode !== null) {
          resolve();
          return;
        }
        previous.once('close', resolve);
        previous.kill();
      });
    }

    electronProcess = launchElectron();
    restarting = false;
  };

  let debounce = null;
  const watcher = watch(path.join(ROOT, 'electron'), (_event, filename) => {
    if (!filename || !filename.endsWith('.ts')) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      restart().catch((err) => console.error('❌ Restart failed:', err.message));
    }, RESTART_DEBOUNCE_MS);
  });
  watcher.on('error', (err) => {
    console.warn('⚠️  electron/ watcher stopped:', err.message);
    console.warn('   Restart `npm run electron:dev` after editing electron/*.ts.');
  });

  process.on('SIGINT', () => {
    watcher.close();
    electronProcess?.markReplaced();
    electronProcess?.kill();
    server.close();
    process.exit(0);
  });
}

start().catch((err) => {
  console.error('Failed to start development environment:', err);
  process.exit(1);
});
