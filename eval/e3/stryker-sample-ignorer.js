// A StrykerJS ignore-plugin so a Stryker run tests (close to) only the sampled mutants.
//
// The run's `mutate` patterns are the sampled mutants' exact ranges, so Stryker only makes
// mutants whose node lies inside one of them. That still includes mutants nested *inside* a
// sampled range (a sampled BlockStatement contains its whole body). This plugin marks those
// nested nodes Ignored: a node is ignored when it lies strictly inside a sampled range and
// contains no sampled range itself. A sampled mutant's own node, or any node around one, is
// never ignored. What is left over (other mutators on the same node) is filtered out of the
// report by exact key afterwards; those extra mutants are counted in RESULTS.md.
//
// No imports: a value plugin is a plain { kind, name, value } object. The sampled ranges come
// from the file named by E3_SAMPLE_RANGES (Babel coordinates: 1-based lines, 0-based columns).
import fs from 'node:fs';

let loaded = null;
const ranges = () => (loaded ||= JSON.parse(fs.readFileSync(process.env.E3_SAMPLE_RANGES, 'utf8')));

function before(a, b) {
  return a.line < b.line || (a.line === b.line && a.column <= b.column);
}
function includes(outer, inner) {
  return before(outer.start, inner.start) && before(inner.end, outer.end);
}
function same(a, b) {
  return a.start.line === b.start.line && a.start.column === b.start.column && a.end.line === b.end.line && a.end.column === b.end.column;
}

export function shouldIgnoreLoc(loc, rs = ranges()) {
  if (!loc) return undefined;
  const inside = rs.some((r) => includes(r, loc) && !same(r, loc));
  if (!inside) return undefined;
  const holdsSample = rs.some((r) => includes(loc, r));
  return holdsSample ? undefined : 'E3: nested inside a sampled mutant, not itself sampled';
}

export const strykerPlugins = [
  { kind: 'Ignore', name: 'e3-sample', value: { shouldIgnore: (path) => shouldIgnoreLoc(path.node.loc) } },
];
