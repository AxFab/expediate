# Expediate threat model & test coverage

This document maps expediate's externally-reachable attack surface to the
property-based fuzz tests that exercise it. It is the artifact an auditor should
read first: each row states an attacker capability, the invariant we claim, and
the test that enforces it.

All tests are property-based (fast-check): they assert an invariant over
thousands of generated inputs rather than a handful of hand-picked cases. Run
them with `npm run fuzz` (from the repo root) or `npm run fuzz --workspace
security`.

## Coverage matrix

| ID    | Attack class                         | Invariant enforced                                                                 | Test file                        |
|-------|--------------------------------------|------------------------------------------------------------------------------------|----------------------------------|
| JWT-1 | `alg: none` / algorithm confusion    | `verifyToken` is pinned to the caller's algorithm; a mismatched header `alg` (incl. `none`, RS256→HS256) is rejected. | `fuzz/jwt.fuzz.ts`               |
| JWT-2 | Signature tampering                  | Flipping any byte of header, payload or signature invalidates the token.           | `fuzz/jwt.fuzz.ts`               |
| JWT-3 | Wrong key                            | A token signed with key A never verifies under key B.                              | `fuzz/jwt.fuzz.ts`               |
| JWT-4 | Expired token replay                 | A token whose `exp` is in the past is rejected.                                     | `fuzz/jwt.fuzz.ts`               |
| JWT-5 | Malformed-token robustness           | `verifyToken` never throws; it returns a structured `{ valid: false }`.            | `fuzz/jwt.fuzz.ts`               |
| MP-1  | Multipart parser DoS                 | `parseMultipartBody` terminates within budget on any adversarial bytes/boundary.   | `fuzz/multipart.fuzz.ts`         |
| MP-2  | Multipart contract safety            | It always returns a `FormPart[]` or throws the documented `{ status: 400 }`.        | `fuzz/multipart.fuzz.ts`         |
| MP-3  | Multipart correctness                | A well-formed body round-trips to the expected parts.                              | `fuzz/multipart.fuzz.ts`         |
| FS-1  | Static path traversal                | No crafted path (raw `..`, `%2e%2e`, encoded slashes, depth) serves a file above the root. | `fuzz/static-traversal.fuzz.ts` |
| RT-1  | Router ReDoS / backtracking          | Matching any path against plain/param/`\d+`/glob routes stays roughly linear.       | `fuzz/router-redos.fuzz.ts`     |

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

## Open findings

- **F-1 (low) — null byte in static path yields 500, not 404.** A request path
  containing `%00` (e.g. `/foo/%00/bar`) decodes to a string with a NUL byte
  that `serveStatic` passes to `fs.stat`, which throws
  `ERR_INVALID_ARG_VALUE`. The router's error handling catches it and returns
  500. No traversal or disclosure occurs (the `FS-1` invariant holds), but the
  static handler should reject NUL-containing paths early and fall through to a
  clean 404. Surfaced by `fuzz/static-traversal.fuzz.ts` (the `%00` token).
  Suggested fix: in `static.ts`, reject paths containing `\0` before the
  `fs.stat` call.
