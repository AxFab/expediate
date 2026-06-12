/**
 * Smoke test — minimal load, just enough to prove the system works and the
 * SLOs are met under no stress. Run this first; if it fails, a bigger run is
 * pointless. Models a couple of interactive users (with think-time).
 *
 *   k6 run scenarios/smoke.ts        (or: npm run smoke)
 */
import { sleep } from 'k6';
import type { Options } from 'k6/options';
import { thresholds, exercise } from '../lib/workload.ts';

export const options: Options = {
  scenarios: {
    smoke: {
      executor: 'constant-vus',
      vus: 2,
      duration: '30s',
    },
  },
  thresholds,
};

export default function (): void {
  exercise();
  sleep(1); // think-time between iterations
}
