/**
 * Property-based fuzzing of the multipart/form-data parser.
 *
 * Attack classes covered (see ../THREAT_MODEL.md):
 *   - MP-1 denial of service — parseMultipartBody must terminate quickly on any
 *     adversarial byte sequence (no infinite loop, no pathological blow-up),
 *     even with malformed boundaries, missing separators, or huge part counts.
 *   - MP-2 contract safety — it must always either return a FormPart[] or throw
 *     the documented `{ status: 400 }` error; never return a non-array, never
 *     throw an unexpected error type.
 *   - MP-3 round-trip — a well-formed body is parsed into the expected parts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import fc from 'fast-check';
import { parseMultipartBody } from '../../src/index.js';

/** Time budget per parse; a hang would blow well past this. */
const MAX_MS = 50;

/** Assert a parse both terminates fast and honours the return/throw contract. */
function parseSafely(contentType: string, data: Buffer): void {
  const start = performance.now();
  try {
    const parts = parseMultipartBody(contentType, data);
    assert.ok(Array.isArray(parts), 'parser must return an array on success');
  } catch (err) {
    // Only the documented bad-request shape is acceptable.
    assert.equal((err as { status?: number }).status, 400);
  }
  const elapsed = performance.now() - start;
  assert.ok(elapsed < MAX_MS, `parse took ${elapsed.toFixed(1)}ms (possible DoS)`);
}

describe('multipart fuzzing', () => {
  it('MP-1/MP-2: never hangs and honours the return/throw contract', () => {
    fc.assert(
      fc.property(
        // Arbitrary boundary token (including empty / weird chars).
        fc.string({ maxLength: 40 }),
        // Arbitrary raw body bytes.
        fc.uint8Array({ maxLength: 4096 }),
        (boundary, bytes) => {
          parseSafely(`multipart/form-data; boundary=${boundary}`, Buffer.from(bytes));
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('MP-1: many tiny parts do not blow up', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), (count) => {
        const boundary = 'X';
        const chunk = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="f"\r\n\r\nv`;
        const body = Buffer.from(chunk.repeat(count) + `\r\n--${boundary}--`);
        parseSafely(`multipart/form-data; boundary=${boundary}`, body);
      }),
      { numRuns: 50 },
    );
  });

  it('MP-3: a well-formed two-part body round-trips', () => {
    const boundary = 'abc123';
    const body = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="a"\r\n\r\n` +
        `hello\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="b"\r\n\r\n` +
        `world\r\n` +
        `--${boundary}--`,
    );
    const parts = parseMultipartBody(`multipart/form-data; boundary=${boundary}`, body);
    assert.equal(parts.length, 2);
    assert.equal(parts[0].content.toString(), 'hello');
    assert.equal(parts[1].content.toString(), 'world');
  });
});
