// Arithmetic for tools that compute from report rows (spec §1.4).
//
// The rule that matters: absence is not zero. The zero-fallback helpers this
// module replaced turned a missing metric into 0, which then read as a real
// measurement -- a line item with no AD_REQUESTS became a 0% fill rate
// rather than an unknown one. Everything here propagates null instead.

// A report cell as a number, or null when it is absent or not numeric.
export function num(cell: unknown): number | null {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null;
  if (typeof cell !== 'string') return null;
  const trimmed = cell.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

// a / b, or null. A zero denominator yields null, not 0: no impressions means
// the rate is unknown, not that it is zero.
export function ratio(a: number | null, b: number | null): number | null {
  if (a === null || b === null || b === 0) return null;
  const r = a / b;
  return Number.isFinite(r) ? r : null;
}

export type Derived = {
  value?: unknown;
  method: string;
  heuristic: boolean;
  inputs: Record<string, unknown>;
  // Present only when the caller has something to say about *why* value is
  // what it is, beyond what method/inputs already show -- e.g. "no lifetime
  // goal" when a goal type makes a metric inapplicable. Most callers omit it.
  reason?: string;
};

// One shape for every derived block, so rows are comparable across tools.
// reason sits right after value -- "what, and why (if there's a why)" --
// ahead of the fixed method/heuristic/inputs trio. Building the object
// key-by-key, rather than conditionally spreading a whole literal, is what
// makes that position deterministic: the other four keys keep the same
// relative order whether or not a given call supplies reason.
export function derived(d: Derived): Record<string, unknown> {
  const out: Record<string, unknown> = { value: d.value };
  if (d.reason !== undefined) out.reason = d.reason;
  out.method = d.method;
  out.heuristic = d.heuristic;
  out.inputs = d.inputs;
  return out;
}

// A fraction (0..1) as a percentage string with 2 decimals, for display
// columns. Formatting only -- callers decide what a null fraction means.
export function pct(fraction: number): string {
  return (fraction * 100).toFixed(2);
}
