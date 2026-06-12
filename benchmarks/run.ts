/**
 * Benchmark runner.
 *
 * For each framework it: spawns the server in a dedicated child process,
 * waits for the `READY <port>` line, then runs every scenario through
 * autocannon (one warmup pass + N measured passes), and records the median
 * requests/sec and latency p99 across the measured passes.
 *
 * Output:
 *   - always writes the full result set to `results.json`
 *   - with `--write-baseline`, also copies it to `baseline.json`
 *
 * Fairness notes are documented in README.md. Key invariants enforced here:
 * server and load generator run in separate processes, every framework is
 * given an identical warmup, and we report the median (not the mean) of
 * several runs to damp outliers.
 *
 * Usage:
 *   node --import tsx run.ts [--write-baseline] [--duration=10] [--runs=3]
 *                            [--connections=50] [--pipelining=1]
 */
import autocannon from 'autocannon';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { SCENARIOS, READY_PREFIX, type Scenario } from './scenarios.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Frameworks under test, mapped to their server entry points. */
const FRAMEWORKS: Record<string, string> = {
  expediate: join(HERE, 'servers', 'expediate.ts'),
  express: join(HERE, 'servers', 'express.ts'),
  fastify: join(HERE, 'servers', 'fastify.ts'),
};

/** Parsed CLI configuration controlling the load profile. */
interface RunConfig {
  writeBaseline: boolean;
  /** Seconds per measured pass. */
  duration: number;
  /** Number of measured passes per scenario (median is reported). */
  runs: number;
  connections: number;
  pipelining: number;
}

/** Metrics captured for one scenario / framework combination. */
interface ScenarioResult {
  /** Median requests/sec across the measured runs (higher is better). */
  requests: number;
  /** Median latency p99 in ms across the measured runs (lower is better). */
  latencyP99: number;
}

/** Full result document, also the shape of `baseline.json`. */
interface ResultDocument {
  meta: {
    createdAt: string;
    node: string;
    config: Omit<RunConfig, 'writeBaseline'>;
  };
  /** results[framework][scenario] */
  results: Record<string, Record<string, ScenarioResult>>;
}

/** Read a `--key=value` numeric flag, falling back to a default. */
function numFlag(name: string, fallback: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const value = Number(hit.split('=')[1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Parse the command line into a {@link RunConfig}. */
function parseConfig(): RunConfig {
  return {
    writeBaseline: process.argv.includes('--write-baseline'),
    duration: numFlag('duration', 10),
    runs: numFlag('runs', 3),
    connections: numFlag('connections', 50),
    pipelining: numFlag('pipelining', 1),
  };
}

/** Spawn a server process and resolve once it reports its listening port. */
function startServer(entry: string): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', entry], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Server ${entry} did not become ready within 15s`));
    }, 15_000);

    let buffer = '';
    proc.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const line = buffer.split('\n').find((l) => l.startsWith(READY_PREFIX));
      if (line) {
        clearTimeout(timer);
        resolve({ proc, port: Number(line.slice(READY_PREFIX.length).trim()) });
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Server ${entry} exited early with code ${code}`));
    });
  });
}

/** Run autocannon once against a scenario and return its summary. */
function fire(port: number, scenario: Scenario, cfg: RunConfig): Promise<autocannon.Result> {
  return autocannon({
    url: `http://127.0.0.1:${port}${scenario.path}`,
    method: scenario.method,
    headers: scenario.body ? { 'content-type': 'application/json' } : undefined,
    body: scenario.body,
    connections: cfg.connections,
    pipelining: cfg.pipelining,
    duration: cfg.duration,
  });
}

/** Median of a numeric array (returns 0 for an empty array). */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Benchmark every scenario for a single framework. */
async function benchFramework(
  name: string,
  entry: string,
  cfg: RunConfig,
): Promise<Record<string, ScenarioResult>> {
  const { proc, port } = await startServer(entry);
  const out: Record<string, ScenarioResult> = {};
  try {
    for (const scenario of SCENARIOS) {
      await fire(port, scenario, cfg); // warmup, discarded
      const reqs: number[] = [];
      const p99s: number[] = [];
      for (let i = 0; i < cfg.runs; i++) {
        const r = await fire(port, scenario, cfg);
        reqs.push(r.requests.average);
        p99s.push(r.latency.p99);
      }
      out[scenario.name] = {
        requests: Math.round(median(reqs)),
        latencyP99: median(p99s),
      };
      console.log(
        `  ${name}/${scenario.name}: ${out[scenario.name].requests} req/s, ` +
          `p99 ${out[scenario.name].latencyP99}ms`,
      );
    }
  } finally {
    proc.kill('SIGKILL');
  }
  return out;
}

/** Entry point. */
async function main(): Promise<void> {
  const cfg = parseConfig();
  console.log(
    `Benchmark: duration=${cfg.duration}s runs=${cfg.runs} ` +
      `connections=${cfg.connections} pipelining=${cfg.pipelining}`,
  );

  const results: Record<string, Record<string, ScenarioResult>> = {};
  for (const [name, entry] of Object.entries(FRAMEWORKS)) {
    console.log(`\n${name}:`);
    results[name] = await benchFramework(name, entry, cfg);
  }

  const doc: ResultDocument = {
    meta: {
      createdAt: new Date().toISOString(),
      node: process.version,
      config: {
        duration: cfg.duration,
        runs: cfg.runs,
        connections: cfg.connections,
        pipelining: cfg.pipelining,
      },
    },
    results,
  };

  writeFileSync(join(HERE, 'results.json'), JSON.stringify(doc, null, 2) + '\n');
  console.log('\nWrote results.json');

  if (cfg.writeBaseline) {
    writeFileSync(join(HERE, 'baseline.json'), JSON.stringify(doc, null, 2) + '\n');
    console.log('Wrote baseline.json');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
