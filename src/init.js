import fs from 'node:fs';
import path from 'node:path';
import { configuredHooksPath, hooksDir, PROOF_DIR, repoRoot } from './git.js';
import { DEFAULT_RULES } from './store.js';

export const HOOK_BEGIN = '# >>> pocp >>>';
export const HOOK_END = '# <<< pocp <<<';

// pocp_run runs pocp, or calls pocp_missing (defined per hook) when it can't be found.
const RUNNER = `pocp_run() {
  if [ -n "$POCP_BIN" ]; then $POCP_BIN "$@"
  elif command -v pocp >/dev/null 2>&1; then pocp "$@"
  elif [ -x ./node_modules/.bin/pocp ]; then ./node_modules/.bin/pocp "$@"
  else pocp_missing
  fi
}`;

const NOT_FOUND = 'pocp: not found (install it with npm i -D pocp, or set POCP_BIN)';

// pre-commit is the gate, so it fails closed. prepare-commit-msg and post-commit also run
// under "git commit --no-verify"; they only add trailers and record landings, so without pocp
// they warn and let the commit through. CI's "pocp verify --require-coverage" still flags a
// commit that needed proof and has none.
export const HOOKS = {
  'pre-commit': `${RUNNER}\npocp_missing() { echo "${NOT_FOUND}; this commit can't be checked, so it is blocked. To commit without the check once: git commit --no-verify (CI's pocp verify still checks it)" >&2; return 1; }\nexport POCP_GATE_SOURCE=hook\npocp_run gate || exit $?`,
  'prepare-commit-msg': `${RUNNER}\npocp_missing() { echo "${NOT_FOUND}; warning: committing without proof trailers. CI's pocp verify will flag this commit if it needed proof" >&2; return 0; }\ncase "$2" in merge|squash) ;; *) pocp_run trailer "$1" "$2" || exit $? ;; esac`,
  'post-commit': `${RUNNER}\npocp_missing() { echo "${NOT_FOUND}; warning: this commit's landing was not recorded" >&2; return 0; }\npocp_run land --quiet || true`,
};

function block(body) {
  return `${HOOK_BEGIN}\n# Installed by pocp. Edit outside these markers; "pocp hooks uninstall" removes this block.\n${body}\n${HOOK_END}\n`;
}

function stripBlock(text) {
  const start = text.indexOf(HOOK_BEGIN);
  if (start === -1) return text;
  const end = text.indexOf(HOOK_END, start);
  if (end === -1) return text;
  return text.slice(0, start) + text.slice(end + HOOK_END.length).replace(/^\n/, '');
}

/** Create `.proof/` with default config and rules. Existing files are left alone. */
export function initProofDir(cwd) {
  const root = repoRoot(cwd);
  const dir = path.join(root, PROOF_DIR);
  const created = [];
  fs.mkdirSync(path.join(dir, 'packets'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'misses'), { recursive: true });
  const write = (rel, content) => {
    const full = path.join(dir, rel);
    if (!fs.existsSync(full)) {
      fs.writeFileSync(full, content);
      created.push(`${PROOF_DIR}/${rel}`);
    }
  };
  write('config.json', `${JSON.stringify({ pocp: 1, packet_ttl_days: 14, run: { mode: 'clean', timeout_ms: 600000, env: 'inherit' }, snapshot: { link: ['node_modules'] } }, null, 2)}\n`);
  write('rules.json', `${JSON.stringify(DEFAULT_RULES, null, 2)}\n`);
  write('.gitignore', 'runs/\n');
  write('packets/.gitkeep', '');
  write('misses/.gitkeep', '');
  return { root, created };
}

/**
 * Install the pre-commit, prepare-commit-msg and post-commit hooks. Existing hooks are
 * kept: the pocp block is appended (or replaced if already there).
 * Refuses when core.hooksPath is set, unless `force`, since that folder may be shared.
 */
export function installHooks(cwd, { force = false } = {}) {
  const root = repoRoot(cwd);
  const custom = configuredHooksPath(root);
  if (custom && !force) {
    return { installed: [], refused: `core.hooksPath is set to "${custom}", which may be shared by other repos. Re-run with --force to install there anyway.` };
  }
  const dir = hooksDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const installed = [];
  const warnings = [];
  for (const [name, body] of Object.entries(HOOKS)) {
    const file = path.join(dir, name);
    let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '#!/bin/sh\n';
    text = stripBlock(text);
    if (!text.startsWith('#!')) text = `#!/bin/sh\n${text}`;
    if (/^\s*exit\b/m.test(text)) warnings.push(`${name}: existing hook calls "exit" before the end; the pocp block may never run`);
    if (!text.endsWith('\n')) text += '\n';
    text += block(body);
    fs.writeFileSync(file, text);
    fs.chmodSync(file, 0o755);
    installed.push(file);
  }
  return { installed, warnings, dir };
}

export function uninstallHooks(cwd) {
  const root = repoRoot(cwd);
  const dir = hooksDir(root);
  const removed = [];
  for (const name of Object.keys(HOOKS)) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const next = stripBlock(text);
    if (next === text) continue;
    if (next.trim() === '#!/bin/sh' || next.trim() === '') fs.rmSync(file);
    else fs.writeFileSync(file, next);
    removed.push(file);
  }
  return { removed };
}

/** Are the pocp hooks installed and runnable? Git silently skips a hook that isn't executable. */
export function hooksHealth(cwd) {
  const root = repoRoot(cwd);
  const dir = hooksDir(root);
  const hooks = {};
  const problems = [];
  for (const name of Object.keys(HOOKS)) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      hooks[name] = 'missing';
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes(HOOK_BEGIN)) hooks[name] = 'no pocp block';
    else if (!(fs.statSync(file).mode & 0o111)) {
      hooks[name] = 'not executable';
      problems.push(`${name} is not executable, so git skips it (run "pocp hooks install" or chmod +x ${file})`);
    } else hooks[name] = 'ok';
  }
  const installed = Object.values(hooks).some((v) => v !== 'missing' && v !== 'no pocp block');
  if (installed) {
    for (const [name, st] of Object.entries(hooks)) if (st === 'missing' || st === 'no pocp block') problems.push(`${name}: ${st}`);
  }
  return { dir, hooks, installed, problems };
}
