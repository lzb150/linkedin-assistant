// Linearity guard that does not depend on the machine: run the same work at n
// and 4n and compare. Linear scales ~4×, quadratic ~16×; the +20 ms absorbs
// timer granularity and JIT warm-up.
//
// This exists because absolute caps ("< 500 ms") flake on shared CI: they pass
// on a fast runner even when the algorithm is quadratic, and fail on a loaded
// one when it is not. Every ReDoS/backtracking guard in this suite uses it.
import assert from "node:assert/strict";

export function assertLinear(label, run, n) {
  run(n);                                          // warm up
  const ms = (k) => { const t = performance.now(); run(k); return performance.now() - t; };
  const t1 = ms(n), t4 = ms(4 * n);
  assert.ok(t4 < 8 * t1 + 20, `${label}: ${n}→${4 * n} took ${t1.toFixed(1)}ms→${t4.toFixed(1)}ms (not linear)`);
}
