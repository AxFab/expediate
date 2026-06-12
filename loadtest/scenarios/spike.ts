/**
 * Spike test — surge and recovery.
 *
 * Sits at a low baseline, jumps almost instantly to a high rate, holds, then
 * drops back. Verifies two things: that the server survives a sudden surge
 * (no crash, errors stay bounded) and — just as important — that latency
 * *recovers* to baseline afterwards rather than staying degraded (no queue
 * build-up or resource exhaustion that outlives the spike).
 *
 *   k6 run scenarios/spike.ts        (or: npm run spike)
 *
 * Tunables via env: BASE_RATE, SPIKE_RATE, MAX_VUS.
 */
import type { Options } from 'k6/options';
import { thresholds, exercise } from '../lib/workload.ts';

const baseRate = Number(__ENV.BASE_RATE) || 100;
const spikeRate = Number(__ENV.SPIKE_RATE) || 3000;
const maxVUs = Number(__ENV.MAX_VUS) || 2000;

export const options: Options = {
  scenarios: {
    spike: {
      executor: 'ramping-arrival-rate',
      startRate: baseRate,
      timeUnit: '1s',
      preAllocatedVUs: Math.min(200, maxVUs),
      maxVUs,
      stages: [
        { target: baseRate, duration: '20s' }, // baseline
        { target: spikeRate, duration: '10s' }, // surge
        { target: spikeRate, duration: '30s' }, // hold
        { target: baseRate, duration: '10s' }, // drop
        { target: baseRate, duration: '30s' }, // observe recovery
      ],
    },
  },
  // Note: a transient threshold breach during the surge is expected; the run
  // still records whether latency returned to budget in the recovery window.
  thresholds,
};

export default function (): void {
  exercise();
}
