// Shared numeric helpers for diagnostic tools that need raw rows (rather
// than the envelope buildReportTool produces) so they can post-process —
// funnel attribution, floor-pricing classification, etc.
import type { Cell } from './values.js';

// ponytail: missing values still count as 0 here; 0.6.0 PR 4 replaces this with null-propagating arithmetic.
export function numOr0(v: Cell | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function pct(fraction: number): string {
  return (fraction * 100).toFixed(2);
}
