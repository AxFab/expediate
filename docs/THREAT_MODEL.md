# Expediate threat model & test coverage

This document maps expediate's externally-reachable attack surface to the
property-based fuzz tests that exercise it. It is the artifact an auditor should
read first: each row states an attacker capability, the invariant we claim, and
the test that enforces it.

All tests are property-based (fast-check): they assert an invariant over
thousands of generated inputs rather than a handful of hand-picked cases. They
live alongside the rest of the suite in `tests/` and run with `npm test`; run
just this subset with `npm run fuzz`.

## Coverage matrix

| ID    | Attack class                         | Invariant enforced                                                                 | Test file                              |
|-------|--------------------------------------|------------------------------------------------------------------------------------|----------------------------------------|
| JWT-1 | `alg: none` / algorithm confusion    | `verifyToken` is pinned to the caller's algorithm; a mismatched header `alg` (incl. `none`, RS256→HS256) is rejected. | `tests/jwt.fuzz.test.ts`               |
| JWT-2 | Signature tampering                  | Flipping any byte of header, payload or signature invalidates the token.           | `tests/jwt.fuzz.test.ts`               |
| JWT-3 | Wrong key                            | A token signed with key A never verifies under key B.                              | `tests/jwt.fuzz.test.ts`               |
| JWT-4 | Expired token replay                 | A token whose `exp` is in the past is rejected.                                     | `tests/jwt.fuzz.test.ts`               |
| JWT-5 | Malformed-token robustness           | `verifyToken` never throws; it returns a structured `{ valid: false }`.            | `tests/jwt.fuzz.test.ts`               |
| MP-1  | Multipart parser DoS                 | `parseMultipartBody` terminates within budget on any adversarial bytes/boundary.   | `tests/multipart.fuzz.test.ts`         |
| MP-2  | Multipart contract safety            | It always returns a `FormPart[]` or throws the documented `{ status: 400 }`.        | `tests/multipart.fuzz.test.ts`         |
| MP-3  | Multipart correctness                | A well-formed body round-trips to the expected parts.                              | `tests/multipart.fuzz.test.ts`         |
| FS-1  | Static path traversal                | No crafted path (raw `..`, `%2e%2e`, encoded slashes, depth) serves a file above the root. | `tests/static-traversal.fuzz.test.ts` |
| RT-1  | Router ReDoS / backtracking          | Matching any path against plain/param/`\d+`/glob routes stays roughly linear.       | `tests/router-redos.fuzz.test.ts`     |

## Surface intentionally NOT covered here

These are out of scope for this fuzz suite and tracked elsewhere or accepted:

- **Decompression bombs / body size limits.** `json()`/`parseBody()` enforce
  `limit` and gzip handling; covered by the unit tests in `tests/misc.test.ts`,
  not re-fuzzed here. A dedicated size/inflate fuzzer is a candidate addition.
- **CSRF & signed-cookie forgery.** The double-submit token and HMAC cookie
  signing have positive/negative unit tests in `tests/middleware.test.ts` and
  `tests/router.test.ts`. Property fuzzing of the HMAC boundary is a candidate
  addition.
- **HTTP request smuggling.** Mostly a property of Node's `http` parser, below
  expediate's layer; not modelled.
- **RS*/ES* JWT key handling.** Only HS256 is fuzzed for confusion/tampering.
  The asymmetric paths have unit coverage in `tests/jwt-auth.test.ts`.

## Resolved findings

- **F-1 (low, resolved) — null byte in static path yielded 500, not 404.** A
  request path containing `%00` (e.g. `/foo/%00/bar`) used to decode to a
  string with a NUL byte that `serveStatic` passed to `fs.stat`, which threw
  `ERR_INVALID_ARG_VALUE` and surfaced as a 500. `static.ts` now rejects any
  path containing a control character (code point < 32, including NUL) before
  the `fs.stat` call, returning 404 (or falling through if `fallthrough` is
  set). Covered by `tests/static-traversal.fuzz.test.ts` (the `%00` token).
