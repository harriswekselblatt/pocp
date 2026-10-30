// verify --rerun runs the pull request's code as the same user that owns the repository, so
// that code can rewrite git objects in the verifier's own object store. A rewritten base blob
// must never be read as the base: verify fails closed instead (SPEC §7.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { git, pocp, read, write, tmpRepo, writeRules } from './helpers.js';

const noHooks = ['-c', 'core.hooksPath=/dev/null'];
const TEST = [
  "import { add, lt } from '../src/math.js';",
  "import { check } from '../lib/check.js';",
  "check(add(2, 3) === 5, 'add');",
  "check(add(-1, 1) === 0, 'add negative');",
  "check(lt(1, 2) === true, 'lt');",
  "check(lt(2, 1) === false, 'lt reversed');",
  "console.log('ok');",
  '',
].join('\n');
// The weakened test: the add assertions are gone.
const WEAK = TEST.split('\n').filter((l) => !l.includes('add(')).join('\n');

function baseRepo() {
  const dir = tmpRepo();
  write(dir, 'package.json', '{ "type": "module" }\n');
  write(dir, 'src/math.js', 'export const add = (a, b) => a + b;\nexport const lt = (a, b) => a < b;\n');
  write(dir, 'lib/check.js', "export function check(ok, what) {\n  if (!ok) { console.error(`failed: ${what}`); process.exit(1); }\n}\n");
  write(dir, 'test/math.test.js', TEST);
  const init = pocp(dir, ['init', '--hooks']);
  assert.equal(init.code, 0, init.stderr);
  writeRules(dir, { requirements: [{ id: 'math', globs: ['src/**', 'test/**', 'lib/**'], obligation: { kind: 'test', run: 'node test/math.test.js' }, source: 'author' }] });
  git(dir, 'add', '-A');
  git(dir, ...noHooks, 'commit', '-q', '-m', 'base');
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}

// Code that, when FORGE_REPO is set, replaces the loose object of the base test file with a
// validly compressed object holding the weakened test (same id, different content).
function forgingMath(blobId, inPlace = false) {
  return [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import zlib from 'node:zlib';",
    'if (process.env.FORGE_REPO) try {',
    `  const f = path.join(process.env.FORGE_REPO, '.git', 'objects', '${blobId.slice(0, 2)}', '${blobId.slice(2)}');`,
    `  const body = Buffer.from(${JSON.stringify(WEAK)});`,
    "  const obj = Buffer.concat([Buffer.from(`blob ${body.length}\\0`), body]);",
    ...(inPlace
      // Same inode, no directory change: only the file's own ctime tells.
      ? ['  fs.chmodSync(f, 0o644);', '  fs.writeFileSync(f, zlib.deflateSync(obj));', '  fs.chmodSync(f, 0o444);']
      : ['  const tmp = `${f}.${process.pid}`;', '  fs.writeFileSync(tmp, zlib.deflateSync(obj));', '  fs.renameSync(tmp, f);']),
    '} catch {}',
    'export const add = (a, b) => a - b;',
    'export const lt = (a, b) => a < b;',
    '',
  ].join('\n');
}

for (const inPlace of [false, true]) test(`PR code that rewrites a base blob in .git/objects (${inPlace ? 'in place' : 'by rename'}) cannot fool the net-change guard`, () => {
  const { dir, base } = baseRepo();
  const blobId = git(dir, 'rev-parse', `${base}:test/math.test.js`);
  // Loose, as in a fresh clone's objects written by a merge or fetch without packing.
  assert.ok(read(dir, `.git/objects/${blobId.slice(0, 2)}/${blobId.slice(2)}`) !== null);

  write(dir, 'src/math.js', 'export const add = (a, b) => a + b;\nexport const lt = (a, b) => a < b;\nexport const zero = 0;\n');
  git(dir, 'add', '-A');
  git(dir, ...noHooks, 'commit', '-q', '-m', 'c1');
  write(dir, 'test/math.test.js', WEAK);
  write(dir, 'src/math.js', forgingMath(blobId, inPlace));
  git(dir, 'add', '-A');
  git(dir, ...noHooks, 'commit', '-q', '-m', 'c2');

  const v = pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage', '--rerun', '--json'], { env: { FORGE_REPO: dir } });
  assert.notEqual(v.code, 0, v.stdout);
  // Never a passing net-change guard read from the forged base.
  const net = v.json?.net;
  assert.ok(!net || (!net.ok && !(net.reruns || []).some((r) => r.kind === 'guard' && r.status === 'passed')), JSON.stringify(net?.reruns));
  // It fails closed on the tampering itself.
  assert.match(`${v.stdout}\n${v.stderr}`, /git state changed[^\n]*\.git\/objects\/[0-9a-f]{2}\/[0-9a-f]+ changed/, `${v.stdout}\n${v.stderr}`);
});

test("an object planted under the net change commit's predictable id is refused; an honest one is reused", async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const zlib = await import('node:zlib');
  const { execFileSync } = await import('node:child_process');
  const { dir, base } = baseRepo();
  write(dir, 'src/math.js', 'export const add = (a, b) => a + b;\nexport const lt = (a, b) => a < b;\nexport const zero = 0;\n');
  git(dir, 'add', '-A');
  git(dir, ...noHooks, 'commit', '-q', '-m', 'c1');
  write(dir, 'src/math.js', 'export const add = (a, b) => a + b;\nexport const lt = (a, b) => a < b;\nexport const one = 1;\n');
  git(dir, 'add', '-A');
  git(dir, ...noHooks, 'commit', '-q', '-m', 'c2');
  const tip = git(dir, 'rev-parse', 'HEAD');
  const verify = () => pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--json']);

  // Honest: verifying the same range twice reuses the stored net change commit.
  const first = verify();
  const second = verify();
  assert.doesNotMatch(first.stdout + first.stderr, /git state changed|object store/);
  assert.doesNotMatch(second.stdout + second.stderr, /git state changed|object store/, second.stdout + second.stderr);
  assert.equal(second.code, first.code);

  // Planted: the same id, holding a commit whose tree is the base's (no change at all).
  const tree = git(dir, 'rev-parse', `${tip}^{tree}`);
  const text = `tree ${tree}\nparent ${base}\nauthor pocp <pocp@invalid> 0 +0000\ncommitter pocp <pocp@invalid> 0 +0000\n\npocp net change ${base}..${tip}\n`;
  const id = execFileSync('git', ['hash-object', '-t', 'commit', '--stdin'], { cwd: dir, input: text, encoding: 'utf8' }).trim();
  const file = path.join(dir, '.git', 'objects', id.slice(0, 2), id.slice(2));
  const fake = Buffer.from(text.replace(tree, git(dir, 'rev-parse', `${base}^{tree}`)));
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, zlib.deflateSync(Buffer.concat([Buffer.from(`commit ${fake.length}\0`), fake])));
  const v = verify();
  assert.notEqual(v.code, 0, v.stdout);
  assert.match(v.stdout + v.stderr, /different content under the id of the net change's commit/, v.stdout + v.stderr);
});

test('an object whose times change but whose content does not (hard links, git refreshing it) is not tampering', () => {
  const { dir, base } = baseRepo();
  const blobId = git(dir, 'rev-parse', `${base}:test/math.test.js`);
  write(dir, 'src/math.js', [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    'if (process.env.TOUCH_REPO) try {',
    `  const f = path.join(process.env.TOUCH_REPO, '.git', 'objects', '${blobId.slice(0, 2)}', '${blobId.slice(2)}');`,
    '  fs.linkSync(f, `${f}.link`); fs.unlinkSync(`${f}.link`);',
    '  fs.utimesSync(f, new Date(), new Date());',
    '} catch {}',
    'export const add = (a, b) => a + b;',
    'export const lt = (a, b) => a < b;',
    '',
  ].join('\n'));
  git(dir, 'add', '-A');
  git(dir, ...noHooks, 'commit', '-q', '-m', 'c1');
  write(dir, 'README.md', 'math\n');
  git(dir, 'add', '-A');
  git(dir, ...noHooks, 'commit', '-q', '-m', 'c2');
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--json'], { env: { TOUCH_REPO: dir } });
  assert.doesNotMatch(v.stdout + v.stderr, /git state changed/, v.stdout + v.stderr);
  assert.ok(v.json, v.stdout + v.stderr);
});

test('a pack rewritten in place, same size, is tampering', () => {
  const { dir, base } = baseRepo();
  git(dir, 'repack', '-a', '-d', '-q');
  write(dir, 'src/math.js', [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    'if (process.env.FORGE_REPO) try {',
    "  const d = path.join(process.env.FORGE_REPO, '.git', 'objects', 'pack');",
    "  for (const n of fs.readdirSync(d).filter((x) => x.endsWith('.pack'))) {",
    '    const f = path.join(d, n); const b = fs.readFileSync(f); b[20] ^= 1;',
    '    fs.chmodSync(f, 0o644); fs.writeFileSync(f, b); fs.chmodSync(f, 0o444);',
    '  }',
    '} catch {}',
    'export const add = (a, b) => a + b;',
    'export const lt = (a, b) => a < b;',
    '',
  ].join('\n'));
  git(dir, 'add', '-A');
  git(dir, ...noHooks, 'commit', '-q', '-m', 'c1');
  write(dir, 'README.md', 'math\n');
  git(dir, 'add', '-A');
  git(dir, ...noHooks, 'commit', '-q', '-m', 'c2');
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--json'], { env: { FORGE_REPO: dir } });
  assert.notEqual(v.code, 0);
  assert.match(v.stdout + v.stderr, /git state changed[^\n]*objects\/pack\/pack-[0-9a-f]+\.pack changed/, v.stdout + v.stderr);
});
