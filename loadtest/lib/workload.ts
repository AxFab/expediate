/**
 * Shared workload and SLOs for every k6 scenario.
 *
 * `exercise()` is one unit of work: the representative request mix fired by the
 * default function of each scenario. It contains NO think-time/sleep, because
 * the arrival-rate executors (ramp, soak, spike) control throughput themselves;
 * scenarios that model interactive users (smoke) add their own sleep.
 */
import http from 'k6/http';
import { check } from 'k6';
import type { Options } from 'k6/options';

/** Base URL of the system under test; injected by the runner. */
export const BASE_URL: string = __ENV.BASE_URL || 'http://localhost:3000';

/**
 * Pass/fail SLOs shared by all scenarios. A run "passes" only if every
 * threshold holds; CI relies on k6's non-zero exit when one is breached.
 */
export const thresholds: Options['thresholds'] = {
  // Less than 1% of requests may fail.
  http_req_failed: ['rate<0.01'],
  // Latency budget. p95 is the primary capacity signal; p99 is a guardrail.
  http_req_duration: ['p(95)<200', 'p(99)<500'],
};

/** Fire the representative request mix once and assert each response is OK. */
export function exercise(): void {
  const hello = http.get(`${BASE_URL}/hello`);
  check(hello, { 'hello 200': (r) => r.status === 200 });

  const param = http.get(`${BASE_URL}/users/12345`);
  check(param, { 'param 200': (r) => r.status === 200 });

  const echo = http.post(`${BASE_URL}/echo`, JSON.stringify({ message: 'hi', count: 42 }), {
    headers: { 'Content-Type': 'application/json' },
  });
  check(echo, { 'echo 200': (r) => r.status === 200 });

  const chain = http.get(`${BASE_URL}/chain`);
  check(chain, { 'chain 200': (r) => r.status === 200 });
}
