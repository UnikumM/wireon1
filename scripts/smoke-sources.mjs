/**
 * Live source check runner — the real YouTube and SoundCloud endpoints.
 *
 * This is the only check in the project that talks to the internet, so it is
 * opt-in and lives outside the default test run. It answers the one question a
 * stubbed suite cannot: are the payload shapes the parsers expect still the
 * shapes these services send today?
 *
 *     npm run smoke:sources
 *
 * A failure here means either the code broke or the service changed. Read the
 * printed titles and durations before assuming the former.
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VITEST = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const TARGET = 'tests/live/sources.live.test.ts';

console.log('[smoke:sources] running the live source checks against the real endpoints\n');

const child = spawn(
  process.execPath,
  [VITEST, 'run', TARGET, '--reporter=verbose', '--no-coverage'],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, WIREON_LIVE: '1' }
  }
);

child.on('error', (err) => {
  console.error(`[smoke:sources] could not start vitest: ${err.message}`);
  process.exit(1);
});

child.on('close', (code) => {
  if (code === 0) {
    console.log('\n[smoke:sources] both sources answered and every track resolved.');
  } else {
    console.error(
      '\n[smoke:sources] a live check failed. If the assertions are about payload ' +
        'shape, a service changed its API; if they are about timeouts, check the connection.'
    );
  }
  process.exit(code ?? 1);
});
