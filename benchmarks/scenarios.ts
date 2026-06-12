/**
 * Shared scenario definitions used by the benchmark runner.
 *
 * Every framework server (servers/*.ts) registers the exact same four routes
 * so that each scenario isolates one cost centre of a framework:
 *
 * - `hello`            — bare routing + plain-text response (framework floor)
 * - `route-param`      — pattern compilation / named-parameter extraction
 * - `json-echo`        — JSON body parsing + JSON serialisation
 * - `middleware-chain` — middleware dispatch overhead (5 no-op layers)
 */

/** A single benchmark scenario: the request the load generator will issue. */
export interface Scenario {
  /** Stable identifier used in results, baseline and reports. */
  name: string;
  /** HTTP method to issue. */
  method: 'GET' | 'POST';
  /** Concrete request path (parameters already substituted). */
  path: string;
  /** Raw JSON body for POST scenarios. */
  body?: string;
}

/** The canonical scenario list, in execution order. */
export const SCENARIOS: Scenario[] = [
  { name: 'hello', method: 'GET', path: '/hello' },
  { name: 'route-param', method: 'GET', path: '/users/12345' },
  {
    name: 'json-echo',
    method: 'POST',
    path: '/echo',
    body: JSON.stringify({ message: 'hello', count: 42 }),
  },
  { name: 'middleware-chain', method: 'GET', path: '/chain' },
];

/**
 * Signal printed on stdout by every server once it is listening.
 * Format: `READY <port>\n` — parsed by the runner to discover the OS-assigned port.
 */
export const READY_PREFIX = 'READY ';
