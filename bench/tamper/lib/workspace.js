import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchEnv, git, pocp, sh } from './proc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const POCP_ROOT = path.resolve(here, '..', '..', '..');

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = isObj(v) && isObj(a?.[k]) ? deepMerge(a[k], v) : v;
  return out;
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`);
};

/** Link shared folders (node_modules) from the source checkout and keep them out of git. */
export function linkShared(dir, target) {
  const exclude = path.join(dir, '.git', 'info', 'exclude');
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const names = target.link || [];
  if (names.length) fs.appendFileSync(exclude, `${names.map((n) => `/${n}`).join('\n')}\n`);
  for (const name of names) {
    const src = path.join(target.sourceDir, name);
    const dst = path.join(dir, name);
    if (fs.existsSync(src) && !fs.existsSync(dst)) fs.symlinkSync(src, dst);
  }
}

/** A fresh local clone of `from`, checked out at `rev`, ready for the bench. */
export async function cloneAt(from, dir, rev, target) {
  fs.rmSync(dir, { recursive: true, force: true });
  await git(path.dirname(dir), ['clone', '-q', '--no-checkout', from, dir]);
  await git(dir, ['checkout', '-q', '--detach', rev]);
  linkShared(dir, target);
  return dir;
}

/**
 * The scenario base: the target's committed code plus its bench setup (rules, config,
 * test script, workflow) and the profile's policy, as one commit on branch bench-base.
 * The source checkout itself is never written to.
 */
export async function prepareBase(target, profile, dir) {
  await cloneAt(target.sourceDir, dir, target.ref || 'HEAD', target);
  await git(dir, ['checkout', '-q', '-b', 'bench-base']);
  const env = benchEnv();
  const setup = target.setup || {};
  if (setup.init || !fs.existsSync(path.join(dir, '.proof', 'rules.json'))) {
    const r = await pocp(dir, ['init'], { env });
    if (r.code !== 0) throw new Error(`pocp init failed: ${r.err}`);
  }
  const rulesFile = path.join(dir, '.proof', 'rules.json');
  let rules = setup.rules ? setup.rules : readJson(rulesFile);
  if (setup.dropRequirements) rules = { ...rules, requirements: (rules.requirements || []).filter((r) => !setup.dropRequirements.includes(r.id)) };
  writeJson(rulesFile, rules);
  const cfgFile = path.join(dir, '.proof', 'config.json');
  let cfg = fs.existsSync(cfgFile) ? readJson(cfgFile) : { pocp: 1 };
  cfg = deepMerge(cfg, setup.config || {});
  cfg = deepMerge(cfg, profile.config || {});
  writeJson(cfgFile, cfg);
  if (setup.scripts) {
    const pkgFile = path.join(dir, 'package.json');
    const pkg = readJson(pkgFile);
    pkg.scripts = { ...(pkg.scripts || {}), ...setup.scripts };
    writeJson(pkgFile, pkg);
  }
  for (const [dest, src] of Object.entries(setup.copyFiles || {})) {
    fs.mkdirSync(path.dirname(path.join(dir, dest)), { recursive: true });
    fs.copyFileSync(path.join(POCP_ROOT, src), path.join(dir, dest));
  }
  await git(dir, ['add', '-A'], { env });
  await git(dir, ['commit', '-q', '--no-verify', '--allow-empty', '-m', `bench: ${target.name} base (${profile.name})`], { env });
  const head = await git(dir, ['rev-parse', 'HEAD']);
  const base = await sh(target.ciCommand, { cwd: dir, env });
  if (base.code !== 0) throw new Error(`${target.name}: "${target.ciCommand}" fails on the untouched base (exit ${base.code}); the bench needs a green baseline.\n${(base.out + base.err).slice(-2000)}`);
  return { dir, head, rules, config: cfg };
}
