/**
 * Expediate benchmark server.
 *
 * Registers the four canonical scenario routes (see ../scenarios.ts).
 * Runs against the local sources (../../src) via tsx so no build is required.
 * Listens on an OS-assigned port and prints `READY <port>` on stdout.
 */
import type { Middleware } from '../../src/index.js';
import { createRouter, json } from '../../src/index.js';
import { READY_PREFIX } from '../scenarios.js';

const app = createRouter();

/** Five no-op middlewares for the `middleware-chain` scenario. */
const noop: Middleware = (_req, _res, next) => next();

app.get('/hello', (_req, res) => res.send('Hello, World!'));

app.get('/users/:id', (req, res) => res.json({ id: req.params.id }));

app.post('/echo', json(), (req, res) => res.json((req as { body?: unknown }).body));

app.get('/chain', noop, noop, noop, noop, noop, (_req, res) => res.send('ok'));

const server = app.listen(0, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  process.stdout.write(`${READY_PREFIX}${port}\n`);
});
