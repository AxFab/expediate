# Expediate benchmarks

Comparative HTTP benchmarks for **expediate** against **express** and
**fastify**, plus a regression gate used in CI.

This is a private npm workspace: its dependencies (autocannon, express,
fastify) never reach the published `expediate` package, which stays
zero-dependency. The root `package.json` only publishes `dist/`.

## Running

From the repo root:

```bash
npm install                 # installs root + this workspace
npm run bench               # run benchmark, write results.json
npm run bench:check         # run benchmark, then fail if expediate regressed
```

From this folder you also get finer control:

```bash
npm run bench -- --duration=20 --runs=5 --connections=100 --pipelining=4
npm run bench:baseline      # run and overwrite baseline.json
```

## Scenarios

Every framework registers the **same four routes** (`scenarios.ts`), each
isolating one cost centre:

| Scenario           | Request            | Measures                              |
|--------------------|--------------------|---------------------------------------|
| `hello`            | `GET /hello`       | bare routing + plain-text floor       |
| `route-param`      | `GET /users/:id`   | pattern compile + param extraction    |
| `json-echo`        | `POST /echo`       | JSON body parse + serialise           |
| `middleware-chain` | `GET /chain`       | dispatch through 5 no-op middlewares  |

## Methodology / fairness

Benchmarks lie easily. The harness enforces:

- **Process isolation** — each server runs in its own child process; the
  autocannon load generator runs in the runner process. The server never
  competes with the load generator for the same event loop.
- **Warmup** — one full pass per scenario is fired and discarded before any
  measured pass, so JIT and GC warm-up don't skew the first numbers.
- **Median of several runs** — each scenario is measured `--runs` times
  (default 3) and we report the median req/s and median p99, not the mean,
  to damp outliers.
- **Pinned Node** — CI pins the Node version; absolute numbers are only
  comparable within the same Node and machine.
- **Identical handlers** — no framework is given a special fast path. In
  particular Fastify is run **without** response schemas (its serialisation
  fast path), because expediate and express have no equivalent. Enabling them
  would benchmark a Fastify-only feature, not routing overhead. If you want to
  showcase that path, add it as a separate, clearly-labelled scenario.

Numbers are indicative, not absolute: a shared CI runner produces more
variance than a quiet dedicated machine. Treat the **ratios** between
frameworks on the same run as the signal.

## Regression gate

`compare.ts` compares `results.json` to the committed `baseline.json` and exits
non-zero if **expediate** drops more than 10% in throughput or rises more than
15% in p99 on any scenario (tunable via `--max-throughput-drop` /
`--max-latency-rise`). Only expediate is gated — express/fastify are reference
points whose upstream changes must never fail our build.

Refresh the baseline intentionally (after a known, justified change) via the
`benchmark` workflow's manual trigger with **Commit the run as the new
baseline** checked, or locally with `npm run bench:baseline` followed by a
commit.

## CI

`.github/workflows/benchmark.yml` runs nightly and on manual dispatch — not on
every push, since shared-runner noise would make a per-PR gate flaky. Results
are uploaded as an artifact every run.
