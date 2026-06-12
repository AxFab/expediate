# Expediate security tests

Property-based fuzzing of expediate's externally-reachable parsers and
security-critical code paths, using [fast-check](https://fast-check.dev) on top
of the project's existing `node:test` harness.

Like `benchmarks/`, this is a private npm workspace: its single dev dependency
(fast-check) never reaches the published `expediate` package, which stays
zero-dependency.

## Running

From the repo root:

```bash
npm install            # installs root + this workspace
npm run fuzz           # run the whole suite
```

Or directly:

```bash
npm run fuzz --workspace security
node --import tsx --test fuzz/jwt.fuzz.ts   # a single suite
```

## What's covered

Four attack classes, each as a property asserted over thousands of generated
inputs. The authoritative mapping (attack → invariant → test) lives in
[THREAT_MODEL.md](./THREAT_MODEL.md). In short:

- **JWT** (`fuzz/jwt.fuzz.ts`) — `alg: none` / algorithm confusion, signature
  tampering, wrong-key, expiry, and malformed-input robustness.
- **Multipart** (`fuzz/multipart.fuzz.ts`) — the `multipart/form-data` parser
  never hangs and always honours its return/throw contract.
- **Static files** (`fuzz/static-traversal.fuzz.ts`) — no crafted path escapes
  the served root to read a sentinel file above it.
- **Router** (`fuzz/router-redos.fuzz.ts`) — pattern matching stays roughly
  linear; no input triggers catastrophic backtracking.

## Interpreting failures

A failed property prints the **minimal counterexample** fast-check shrank to —
the smallest input that breaks the invariant. Treat it as a reproduction case:
copy it into a focused unit test in `tests/`, fix the source, then let the
property guard against regressions.

Findings that are real but not yet fixed are recorded under **Open findings** in
THREAT_MODEL.md.

## CI

`.github/workflows/security.yml` runs the suite on every push and pull request
and **fails the build** on any property violation — unlike the benchmarks,
these are correctness invariants, not noisy measurements.

## Adding a fuzzer

1. Create `fuzz/<surface>.fuzz.ts` using `node:test` + fast-check.
2. Import the target only from `../../src` (run via tsx, no build needed).
3. Give each property a stable ID (e.g. `XX-1`) and add a row to the coverage
   matrix in THREAT_MODEL.md.
