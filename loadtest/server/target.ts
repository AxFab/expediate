/**
 * Load-test target server.
 *
 * A minimal expediate server exposing the same four routes as the benchmark
 * harness, used as the system-under-test for local k6 runs. Boots against the
 * local sources (../../src) via tsx — no build required.
 *
 * Listens on `PORT` (default 0 = OS-assigned) and prints `READY <port>` on
 * stdout so the runner can discover the actual port.
 */
import type { Middleware } from '../../src/index.js';
import { createRouter, json } from '../../src/index.js';

const app = createRouter();

/** Five no-op middlewares for the `/chain` route. */
const noop: Middleware = (_req, _res, next) => next();

app.get('/hello', (_req, res) => res.send('Hello, World!'));
app.get('/users/:id', (req, res) => res.json({ id: req.params.id }));
app.post('/echo', json(), (req, res) => res.json((req as { body?: unknown }).body));
app.get('/chain', noop, noop, noop, noop, noop, (_req, res) => res.send('ok'));

const port = Number(process.env.PORT) || 0;
const server = app.listen(port, () => {
  const address = server.address();
  const actual = typeof address === 'object' && address ? address.port : port;
  process.stdout.write(`READY ${actual}\n`);
});
