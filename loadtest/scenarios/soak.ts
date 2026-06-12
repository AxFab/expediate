/**
 * Soak test — stability over time.
 *
 * Holds a constant, comfortably-sub-capacity request rate for a long duration
 * to surface slow problems that a short run hides: memory leaks, file-descriptor
 * growth, unbounded caches/maps (e.g. the rate-limit and refresh-token stores),
 * and latency drift. Watch RSS on the target across the run — it should plateau.
 *
 *   k6 run scenarios/soak.ts         (or: npm run soak)
 *
 * Tunables via env: RATE (req/s), DURATION (e.g. '30m'). Default DURATION is
 * short so a local run is quick; raise it to 1h+ for a real soak.
 */
import type { Options } from 'k6/options';
import { thresholds, exercise } from '../lib/workload.ts';

const rate = Number(__ENV.RATE) || 200;
const duration = __ENV.DURATION || '10m';

export const options: Options = {
  scenarios: {
    soak: {
      executor: 'constant-arrival-rate',
      rate,
      timeUnit: '1s',
      duration,
      preAllocatedVUs: Math.max(50, rate),
      maxVUs: Math.max(100, rate * 4),
    },
  },
  thresholds,
};

export default function (): void {
  exercise();
}
