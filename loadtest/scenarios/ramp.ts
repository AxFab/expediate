/**
 * Ramp test — capacity discovery.
 *
 * Drives a steadily increasing *request rate* (not VU count) until the latency
 * SLO breaks. Because `abortOnFail` is set on the p95 threshold, k6 stops the
 * run shortly after the system can no longer hold the budget. The highest
 * sustained rate before that breach is your capacity estimate at this SLO — see
 * README "Estimating capacity".
 *
 * `ramping-arrival-rate` keeps throughput constant regardless of latency, so a
 * slowing server causes k6 to spin up more VUs (up to `maxVUs`) rather than
 * silently lowering load — which is exactly what you want when finding a knee.
 *
 *   k6 run scenarios/ramp.ts         (or: npm run ramp)
 *
 * Tunables via env: START_RATE, MAX_RATE, MAX_VUS.
 */
import type { Options } from 'k6/options';
import { thresholds, exercise } from '../lib/workload.ts';

const startRate = Number(__ENV.START_RATE) || 100;
const maxRate = Number(__ENV.MAX_RATE) || 5000;
const maxVUs = Number(__ENV.MAX_VUS) || 2000;

export const options: Options = {
  scenarios: {
    ramp: {
      executor: 'ramping-arrival-rate',
      startRate,
      timeUnit: '1s',
      preAllocatedVUs: Math.min(200, maxVUs),
      maxVUs,
      stages: [
        { target: Math.round(maxRate * 0.1), duration: '30s' },
        { target: Math.round(maxRate * 0.25), duration: '30s' },
        { target: Math.round(maxRate * 0.5), duration: '30s' },
        { target: Math.round(maxRate * 0.75), duration: '30s' },
        { target: maxRate, duration: '60s' },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    // Abort once p95 stays above budget for 10s — that marks the knee.
    http_req_duration: [{ threshold: 'p(95)<200', abortOnFail: true, delayAbortEval: '10s' }],
  },
};

export default function (): void {
  exercise();
}
