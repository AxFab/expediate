/**
 * Express benchmark server.
 *
 * Registers the four canonical scenario routes (see ../scenarios.ts).
 * Listens on an OS-assigned port and prints `READY <port>` on stdout.
 */
import express from 'express';
import type { RequestHandler } from 'express';
import { READY_PREFIX } from '../scenarios.js';

const app = express();

/** Five no-op middlewares for the `middleware-chain` scenario. */
const noop: RequestHandler = (_req, _res, next) => next();

app.get('/hello', (_req, res) => {
  res.send('Hello, World!');
});

app.get('/users/:id', (req, res) => {
  res.json({ id: req.params.id });
});

app.post('/echo', express.json(), (req, res) => {
  res.json(req.body);
});

app.get('/chain', noop, noop, noop, noop, noop, (_req, res) => {
  res.send('ok');
});

const server = app.listen(0, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  process.stdout.write(`${READY_PREFIX}${port}\n`);
});
