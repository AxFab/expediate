# Expediate load tests

Stress, capacity, soak and spike testing with [k6](https://grafana.com/docs/k6/).

Unlike `benchmarks/` (which compares routing overhead) and `security/` (which
asserts correctness), this workspace answers an operational question: **how much
traffic can one expediate instance carry before it breaks a latency SLO, and is
it stable over time?**

k6 is an external Go binary, not an npm package — so it never touches the
published zero-dependency package. The only dev dependency here is `@types/k6`
for type-checking the scenario scripts.

## Prerequisites

Install k6 **v0.57 or newer** (older versions can't run `.ts` directly):
<https://grafana.com/docs/k6/latest/set-up/install-k6/>

## Running

The runner boots a local expediate target server, points k6 at it, and tears it
down afterwards:

```bash
npm run smoke    # 30s, 2 VUs — sanity check, run this first
npm run ramp     # capacity discovery (stops at the knee)
npm run soak     # sustained load, leak/stability hunt
npm run spike    # sudden surge + recovery
npm run typecheck
```

To test a **deployed** instance instead of a local one, run k6 directly with a
`BASE_URL`:

```bash
BASE_URL=https://staging.example.com k6 run scenarios/ramp.ts
```

Most knobs are env-overridable, e.g. `MAX_RATE=10000 npm run ramp` or
`DURATION=1h RATE=500 npm run soak`.

## Scenarios

| Scenario | Executor                 | Question it answers                                  |
|----------|--------------------------|------------------------------------------------------|
| smoke    | constant-vus             | Does it work at all, within SLO, under trivial load? |
| ramp     | ramping-arrival-rate     | At what request rate does p95 break? (capacity)      |
| soak     | constant-arrival-rate    | Is it stable for a long time? (leaks, drift)         |
| spike    | ramping-arrival-rate     | Does it survive a surge and recover afterwards?      |

The shared workload (`lib/workload.ts`) fires the same four-route mix as the
benchmarks (hello, route-param, json-echo, middleware-chain) so numbers are
comparable across workspaces. SLOs live there too: `http_req_failed rate<1%`,
`p95<200ms`, `p99<500ms`.

## Estimating capacity

The point of `ramp` is to find the **knee** — the request rate at which latency
leaves budget. Because the p95 threshold has `abortOnFail`, k6 stops shortly
after the breach; read the last sustained stage before the abort as the
single-instance capacity at this SLO.

To turn that into an infrastructure estimate:

1. Run `ramp` against **one** instance sized like production. Note the knee
   rate `R` (req/s at p95 < 200ms).
2. While it runs, sample the target's CPU and RSS (e.g. `top`, `docker stats`,
   or your platform metrics). Note utilisation at the knee.
3. Required instances ≈ `ceil(peak_expected_rps / R)`, then add headroom
   (commonly target ~60–70% of `R` per instance, not 100%, so spikes and GC
   pauses don't breach the SLO).
4. Validate the chosen instance count with a `soak` at the target rate to
   confirm stability, and a `spike` to confirm surge recovery.

Treat `R` as per-Node-version and per-hardware: re-measure when either changes.
Numbers from a shared CI runner are noisier than a dedicated box — use CI for
trend/canary, a quiet machine or real environment for capacity decisions.

## CI

`.github/workflows/loadtest.yml` runs `smoke` nightly as a canary and lets you
trigger any scenario manually. It is intentionally **not** a per-PR gate —
load runs are too heavy and noisy for that role.
