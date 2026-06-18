/**
 * Local load-test runner.
 *
 * Boots the expediate target server on an OS-assigned port, then runs the
 * requested k6 scenario against it with BASE_URL wired in, and tears the server
 * down on exit. k6 must be installed and on PATH:
 *   https://grafana.com/docs/k6/latest/set-up/install-k6/  (v0.57+ for .ts)
 *
 * Usage: node scripts/run-local.mjs <smoke|ramp|soak|spike>
 */
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const VALID = ['smoke', 'ramp', 'soak', 'spike'];

const scenario = process.argv[2];
if (!VALID.includes(scenario)) {
  console.error(`Usage: node scripts/run-local.mjs <${VALID.join('|')}>`);
  process.exit(1);
}

// Fail early with a helpful message if k6 is missing.
const probe = spawnSync('k6', ['version'], { encoding: 'utf8' });
if (probe.error) {
  console.error(
    'k6 not found on PATH. Install it (v0.57+ for native TypeScript):\n' +
      '  https://grafana.com/docs/k6/latest/set-up/install-k6/',
  );
  process.exit(127);
}

/** Spawn the target server and resolve once it prints `READY <port>`. */
function startTarget() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'server', 'target.ts')], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, PORT: '0' },
    });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('target server did not become ready within 15s'));
    }, 15_000);

    let buffer = '';
    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/READY (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ proc, port: Number(match[1]) });
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`target server exited early (code ${code})`));
    });
  });
}

const { proc, port } = await startTarget();
const baseUrl = `http://127.0.0.1:${port}`;
console.log(`Target up at ${baseUrl} — running k6 "${scenario}"\n`);

const k6 = spawnSync('k6', ['run', join(ROOT, 'scenarios', `${scenario}.ts`)], {
  stdio: 'inherit',
  env: { ...process.env, BASE_URL: baseUrl },
});

proc.kill('SIGKILL');
process.exit(k6.status ?? 1);
