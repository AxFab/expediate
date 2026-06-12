/**
 * Regression gate.
 *
 * Compares the most recent `results.json` against the committed `baseline.json`
 * and exits non-zero if expediate has regressed beyond the allowed tolerance on
 * any scenario. This is the script the CI workflow runs to fail a pull request.
 *
 * Only expediate is gated: express and fastify appear in the report as moving
 * reference points, but a change in their numbers (different machine, new
 * upstream release) must never fail expediate's build. We compare expediate to
 * its own historical baseline, which is robust to absolute hardware speed since
 * both numbers come from the same run for the ratio columns and from comparable
 * runs for the gate.
 *
 * Tolerance (override via flags):
 *   --max-throughput-drop=0.10   allow up to 10% fewer req/s
 *   --max-latency-rise=0.15      allow up to 15% higher p99
 *
 * Usage: node --import tsx compare.ts
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATED = 'expediate';

interface ScenarioResult {
  requests: number;
  latencyP99: number;
}
interface ResultDocument {
  results: Record<string, Record<string, ScenarioResult>>;
}

/** Read a `--key=value` numeric flag, falling back to a default. */
function numFlag(name: string, fallback: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const value = Number(hit.split('=')[1]);
  return Number.isFinite(value) ? value : fallback;
}

/** Load and parse a result document, exiting with a clear message if absent. */
function load(file: string): ResultDocument {
  const path = join(HERE, file);
  if (!existsSync(path)) {
    console.error(`Missing ${file}. Run \`npm run bench:baseline\` to create a baseline first.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as ResultDocument;
}

const maxDrop = numFlag('max-throughput-drop', 0.1);
const maxRise = numFlag('max-latency-rise', 0.15);

const baseline = load('baseline.json');
const current = load('results.json');

const baseScenarios = baseline.results[GATED] ?? {};
const curScenarios = current.results[GATED] ?? {};

interface Failure {
  scenario: string;
  metric: 'throughput' | 'latency-p99';
  baseline: number;
  current: number;
  changePct: number;
}
const failures: Failure[] = [];

console.log(`Regression gate for "${GATED}" (max drop ${maxDrop * 100}%, max p99 rise ${maxRise * 100}%)\n`);

for (const [scenario, base] of Object.entries(baseScenarios)) {
  const cur = curScenarios[scenario];
  if (!cur) {
    console.warn(`  ${scenario}: missing in current results, skipped`);
    continue;
  }

  // Throughput: a drop is negative change; fail if it falls below tolerance.
  const throughputChange = (cur.requests - base.requests) / base.requests;
  if (throughputChange < -maxDrop) {
    failures.push({
      scenario,
      metric: 'throughput',
      baseline: base.requests,
      current: cur.requests,
      changePct: throughputChange * 100,
    });
  }

  // Latency p99: a rise is positive change; fail if it grows beyond tolerance.
  // Guard against a zero baseline (sub-millisecond p99 on very short runs).
  const latencyChange = base.latencyP99 === 0 ? 0 : (cur.latencyP99 - base.latencyP99) / base.latencyP99;
  if (latencyChange > maxRise) {
    failures.push({
      scenario,
      metric: 'latency-p99',
      baseline: base.latencyP99,
      current: cur.latencyP99,
      changePct: latencyChange * 100,
    });
  }

  const arrow = throughputChange >= 0 ? '+' : '';
  console.log(
    `  ${scenario}: ${cur.requests} req/s (${arrow}${(throughputChange * 100).toFixed(1)}%), ` +
      `p99 ${cur.latencyP99}ms (${latencyChange >= 0 ? '+' : ''}${(latencyChange * 100).toFixed(1)}%)`,
  );
}

if (failures.length > 0) {
  console.error('\nRegression detected:');
  for (const f of failures) {
    console.error(
      `  ${f.scenario} ${f.metric}: ${f.baseline} -> ${f.current} (${f.changePct.toFixed(1)}%)`,
    );
  }
  process.exit(1);
}

console.log('\nNo regression. ✔');
