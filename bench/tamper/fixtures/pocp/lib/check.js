// Bench fixture: a hand-written assertion helper, outside the test folders, that a test imports.
export function eq(actual, expected, what = 'value') {
  if (actual !== expected) throw new Error(`${what}: expected ${expected}, got ${actual}`);
}
