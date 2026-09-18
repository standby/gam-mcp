// Arithmetic for tools that compute from report rows (spec §1.4).
//
// The rule that matters: absence is not zero. numOr0/pctOrZero/Number(x)||0
// turned a missing metric into 0, which then read as a real measurement -- a
// line item with no AD_REQUESTS became a 0% fill rate rather than an unknown
// one. Everything here propagates null instead.

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
};

// One shape for every derived block, so rows are comparable across tools.
export function derived(d: Derived): Record<string, unknown> {
  return { value: d.value, method: d.method, heuristic: d.heuristic, inputs: d.inputs };
}

// A fraction (0..1) as a percentage string with 2 decimals, for display
// columns. Formatting only -- callers decide what a null fraction means.
export function pct(fraction: number): string {
  return (fraction * 100).toFixed(2);
}
