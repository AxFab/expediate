/**
 * Fastify benchmark server.
 *
 * Registers the four canonical scenario routes (see ../scenarios.ts).
 * Plain handlers, no response serialisation schemas — see README "Fairness".
 * Listens on an OS-assigned port and prints `READY <port>` on stdout.
 */
import Fastify from 'fastify';
import type { preHandlerHookHandler } from 'fastify';
import { READY_PREFIX } from '../scenarios.js';

const app = Fastify({ logger: false });

/** Five no-op preHandlers for the `middleware-chain` scenario. */
const noop: preHandlerHookHandler = (_req, _reply, done) => done();

app.get('/hello', (_req, reply) => {
  reply.type('text/plain').send('Hello, World!');
});

app.get('/users/:id', (req, reply) => {
  reply.send({ id: (req.params as { id: string }).id });
});

app.post('/echo', (req, reply) => {
  reply.send(req.body);
});

app.get('/chain', { preHandler: [noop, noop, noop, noop, noop] }, (_req, reply) => {
  reply.type('text/plain').send('ok');
});

await app.listen({ port: 0, host: '127.0.0.1' });
const address = app.server.address();
const port = typeof address === 'object' && address ? address.port : 0;
process.stdout.write(`${READY_PREFIX}${port}\n`);
