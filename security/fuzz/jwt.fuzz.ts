/**
 * Property-based fuzzing of the JWT sign/verify core.
 *
 * Attack classes covered (see ../THREAT_MODEL.md):
 *   - JWT-1 algorithm confusion / `alg: none` — verifyToken must reject any
 *     token whose header algorithm differs from the algorithm the caller
 *     expects, regardless of payload contents.
 *   - JWT-2 signature tampering — flipping any byte of header, payload or
 *     signature must invalidate the token.
 *   - JWT-3 wrong key — a token signed with key A must never verify under key B.
 *   - JWT-4 expiry — a token whose `exp` is in the past must be rejected.
 *   - JWT-5 robustness — verifyToken must never throw on arbitrary input; it
 *     returns a discriminated result instead.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import fc from 'fast-check';
import { signToken, verifyToken } from '../../src/jwt-auth.js';

/** Non-empty secret strings (HMAC keys). */
const secret = fc.string({ minLength: 8, maxLength: 64 });
/** Arbitrary JSON-safe claim payloads. */
const payload = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 12 }),
  fc.oneof(fc.string(), fc.integer(), fc.boolean()),
  { maxKeys: 6 },
);

describe('jwt fuzzing', () => {
  it('JWT-2/3: a tampered or wrong-key token never verifies', () => {
    fc.assert(
      fc.property(payload, secret, secret, fc.nat(), (claims, keyA, keyB, mutateAt) => {
        const token = signToken(claims, keyA, 3600, 'HS256');

        // Genuine token under the genuine key is valid.
        assert.equal(verifyToken(token, keyA, 'HS256').valid, true);

        // Flip one character somewhere in the compact token.
        const pos = mutateAt % token.length;
        const orig = token[pos];
        const swapped = orig === 'A' ? 'B' : 'A';
        const tampered = token.slice(0, pos) + swapped + token.slice(pos + 1);
        if (tampered !== token) {
          assert.equal(verifyToken(tampered, keyA, 'HS256').valid, false);
        }

        // A different key must never validate the genuine token.
        if (keyB !== keyA) {
          assert.equal(verifyToken(token, keyB, 'HS256').valid, false);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('JWT-1: algorithm mismatch in the header is rejected (no alg confusion / none)', () => {
    fc.assert(
      fc.property(payload, secret, fc.constantFrom('none', 'HS384', 'HS512', 'RS256'), (claims, key, headerAlg) => {
        // Forge a token whose header claims a different algorithm than the
        // verifier expects (HS256). This models `alg: none` and RS256->HS256
        // confusion: the verifier is pinned to one algorithm by its argument
        // and must not trust the header.
        const forgedHeader = Buffer.from(JSON.stringify({ alg: headerAlg, typ: 'JWT' }))
          .toString('base64')
          .replace(/=/g, '')
          .replace(/\+/g, '-')
          .replace(/\//g, '_');
        const body = Buffer.from(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + 3600 }))
          .toString('base64')
          .replace(/=/g, '')
          .replace(/\+/g, '-')
          .replace(/\//g, '_');
        // No / empty signature — the classic alg:none forgery.
        const forged = `${forgedHeader}.${body}.`;

        assert.equal(verifyToken(forged, key, 'HS256').valid, false);
      }),
      { numRuns: 300 },
    );
  });

  it('JWT-4: expired tokens are rejected', () => {
    fc.assert(
      fc.property(payload, secret, fc.integer({ min: 1, max: 100000 }), (claims, key, agoSeconds) => {
        // expiresIn negative => exp already in the past.
        const token = signToken(claims, key, -agoSeconds, 'HS256');
        assert.equal(verifyToken(token, key, 'HS256').valid, false);
      }),
      { numRuns: 300 },
    );
  });

  it('JWT-5: verifyToken never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), secret, (garbage, key) => {
        const res = verifyToken(garbage, key, 'HS256');
        // Always a structured result, never an exception.
        assert.equal(typeof res.valid, 'boolean');
        assert.equal(res.valid, false); // random strings are not valid tokens
      }),
      { numRuns: 1000 },
    );
  });
});
