// The Claude Code plugin (plugins/pocp, listed by .claude-plugin/marketplace.json): its guard
// refuses the commands that go around POCP in a repository that uses it, and lets everything
// else through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleRepo, tmpRepo } from './helpers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(ROOT, 'plugins', 'pocp');
const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// The decision the guard returns for one Bash command run in `cwd`: 'deny' or 'allow'.
function decide(cwd, command, tool = 'Bash') {
  const r = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts', 'guard.mjs')], {
    input: JSON.stringify({ tool_name: tool, tool_input: { command }, cwd }),
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  if (!r.stdout.trim()) return { decision: 'allow' };
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason };
}

const DENIED = [
  'git commit --no-verify -m "x"',
  'git commit -nm "x"',
  'git add -A && git commit -n',
  'git -c core.hooksPath=/dev/null commit -m x',
  'git config core.hooksPath /dev/null',
  'git push --force',
  'git push -f origin feature',
  'git push --force-with-lease origin feature',
  'git push origin +main',
  'gh pr edit 12 --add-label pocp-approve-tests',
  'gh pr edit 12 -R o/r --add-label "pocp-approve-policy"',
  'gh api repos/o/r/issues/12/labels -f "labels[]=pocp-approve-tests"',
  'pocp approve o/r#12',
  'npx pocp approvals --approve',
  'pocp verify main..HEAD --rerun --accept-test-change=abc123',
  'pocp verify main..HEAD --rerun --accept-policy-change abc123',
  'gh pr merge 12 --admin',
  'npx pocp hooks uninstall',
  'pocp ci off',
  'npx pocp ci off --json',
  'node bin/pocp.js ci off --disable-billing-failed',
  'pocp doctor --disable-billing-failed',
  'npx pocp init --hooks --local',
  'gh workflow disable test.yml',
  'gh workflow disable -R o/r "CI"',
  'gh api -X PUT repos/o/r/actions/workflows/123/disable',
  'gh api --method PUT "repos/o/r/actions/workflows/test.yml/disable"',
  // 1. the package name, with any runner
  'npx proof-of-change ci off',
  'npx proof-of-change@1.5.0 init --local',
  'pnpm dlx proof-of-change approve o/r#12',
  'yarn dlx proof-of-change hooks uninstall',
  'bunx proof-of-change@1.5.0 ci off',
  'pocp --json ci off',
  'npx -p proof-of-change pocp ci off',
  'node node_modules/proof-of-change/bin/pocp.js init --local',
  // 2. flags between gh's command words
  'gh workflow -R o/r disable ci.yml',
  'gh pr -R o/r merge 12 --admin',
  // 3. a label added when a pull request is created, or through gh issue / gh api
  'gh pr create --label pocp-approve-policy --title x',
  'gh pr create -l pocp-approve-tests',
  'gh pr new -l pocp-approve-tests',
  'gh api -X PATCH repos/o/r/issues/12 -f "labels[]=pocp-approve-tests"',
  'gh pr create --label=docs,pocp-approve-tests',
  'gh issue edit 12 --add-label pocp-approve-tests',
  'gh api -X POST repos/o/r/issues/12/labels -f labels[]=pocp-approve-tests',
  'echo \'{"labels":["pocp-approve-tests"]}\' | gh api repos/o/r/issues/12/labels --input -',
  // 4. apostrophes inside double quotes don't hide a flag between them
  'git commit -m "don\'t stop" --no-verify -m "it\'s fine"',
  'git commit -m "$(cat <<\'EOF\'\nfix: don\'t "drop" -n\nEOF\n)" --no-verify',
  // 6. writes to core.hooksPath, in every form
  'git config --local core.hooksPath .x',
  'git config --global core.hooksPath .x',
  'git config --unset core.hooksPath',
  'git config set core.HooksPath .x',
  'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x',
  // other ways in: subshells, prefixes, command substitution
  '(git commit -n)',
  'sudo git push -f',
  'echo "$(pocp ci off)"',
  'npm run verify -- --accept-uncovered',
];

const ALLOWED = [
  'git commit -m "fix: drop the --no-verify and -n advice from the docs"',
  'git commit -am "x"',
  'git push',
  'git push origin feature',
  'gh pr edit 12 --remove-label pocp-approve-tests',
  'gh pr view 12 --json labels',
  'pocp verify main..HEAD --require-coverage --rerun',
  'pocp approvals',
  'pocp fix --intent "add a note"',
  'gh pr merge 12 --merge --auto',
  'npm test',
  'pocp ci on',
  'pocp ci required --apply',
  'pocp doctor',
  'gh workflow enable test.yml',
  'gh workflow list --all',
  'pocp init --hooks --github',
  'git commit -m "docs: when to run pocp ci off and gh workflow disable"',
  'gh api repos/o/r/actions/workflows',
  // 4. a commit message in a heredoc, with quotes and flags in its text
  'git commit -m "$(cat <<\'EOF\'\nfix: don\'t "drop" -n or --no-verify\nEOF\n)"',
  'git commit -m x # --no-verify',
  'git commit -m x 2>&1 | tail -3',
  // 6. reading or searching for core.hooksPath
  'git config --get core.hooksPath',
  'git config core.hooksPath',
  'rg core.hooksPath src',
  'grep -r core.hooksPath .',
  // 7. reading labels, and naming the label for the user
  'gh api repos/o/r/issues/3/labels | jq \'.[] | select(.name | startswith("pocp-approve-"))\'',
  'gh api repos/o/r/issues/3/labels --jq \'.[].name | select(startswith("pocp-approve-"))\'',
  'gh pr comment 12 --body "needs pocp-approve-tests"',
  'gh pr create --title x --body "-l pocp-approve-tests is for the user to add"',
  'gh api -X DELETE repos/o/r/issues/3/labels/pocp-approve-tests',
  'gh api repos/o/r/issues/12/comments -f body="needs pocp-approve-tests"',
  // 8. -n belongs to git commit only
  'git log --grep=commit -n 5',
  'git commit -m"note" -a',
  'pocp fix --intent "pocp ci off docs"',
];

test('in a repository that uses POCP, the guard refuses commands that go around it, and says what to do instead', () => {
  const dir = sampleRepo({ deep: false });
  for (const command of DENIED) {
    const d = decide(dir, command);
    assert.equal(d.decision, 'deny', command);
    assert.match(d.reason, /^POCP: .+\. .+/, command);
  }
});

test('in a repository that uses POCP, ordinary commands pass', () => {
  const dir = sampleRepo({ deep: false });
  for (const command of ALLOWED) assert.equal(decide(dir, command).decision, 'allow', command);
});

test('a command too deeply nested to read is refused in a POCP repository, never let through by a crash', () => {
  const deep = `echo ${'$( '.repeat(20000)}`;
  const d = decide(sampleRepo({ deep: false }), deep);
  assert.equal(d.decision, 'deny');
  assert.match(d.reason, /nested too deeply/);
  assert.equal(decide(tmpRepo(), deep).decision, 'allow', 'outside a POCP repository the guard does nothing');
});

test('outside a POCP repository, and for tools other than Bash, the guard does nothing', () => {
  const plain = tmpRepo();
  for (const command of DENIED) assert.equal(decide(plain, command).decision, 'allow', command);
  assert.equal(decide(sampleRepo({ deep: false }), 'git commit --no-verify', 'Edit').decision, 'allow');
});

test('a command aimed at a POCP repository from outside it is refused; one aimed elsewhere passes', () => {
  const repo = sampleRepo({ deep: false });
  const plain = tmpRepo();
  for (const command of [
    `cd ${repo} && pocp ci off`,
    `cd "${repo}"; git push -f`,
    `git -C ${repo} commit --no-verify`,
    `cd ${path.dirname(repo)} && git -C ${path.basename(repo)} commit -n`,
  ]) assert.equal(decide(plain, command).decision, 'deny', command);
  assert.equal(decide(path.dirname(repo), `cd ${path.basename(repo)} && npx proof-of-change ci off`).decision, 'deny');
  assert.equal(decide(plain, `cd ${plain} && git commit --no-verify`).decision, 'allow');
  assert.equal(decide(plain, 'git -C ../elsewhere commit --no-verify').decision, 'allow');
});

test('the marketplace lists the plugin; names and the version stay in step with the package', () => {
  const market = json(path.join(ROOT, '.claude-plugin', 'marketplace.json'));
  const plugin = json(path.join(PLUGIN, '.claude-plugin', 'plugin.json'));
  const entry = market.plugins.find((p) => p.name === plugin.name);
  assert.ok(entry, 'marketplace lists the plugin by its manifest name');
  assert.equal(path.resolve(ROOT, entry.source), PLUGIN);
  assert.equal(plugin.version, json(path.join(ROOT, 'package.json')).version);
  const hooks = json(path.join(PLUGIN, 'hooks', 'hooks.json')).hooks.PreToolUse[0];
  assert.equal(hooks.matcher, 'Bash');
  assert.match(hooks.hooks[0].args[0], /^\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/guard\.mjs$/);
});

test("the plugin's skill teaches the same workflow as examples/agent-instructions.md", () => {
  const body = (text) => text.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  const skill = fs.readFileSync(path.join(PLUGIN, 'skills', 'pocp', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: pocp\ndescription: .+\n---\n/);
  const instructions = fs.readFileSync(path.join(ROOT, 'examples', 'agent-instructions.md'), 'utf8');
  assert.equal(body(skill), instructions.slice(instructions.indexOf('\n---\n') + 5).trim());
});

test('the plugin folder has what the Claude plugin directory requires: a README of 40+ words and a license', () => {
  const readme = fs.readFileSync(path.join(PLUGIN, 'README.md'), 'utf8');
  const prose = readme.replace(/```[\s\S]*?```/g, ' ');
  const words = prose.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  assert.ok(words.length >= 40, `README has ${words.length} words outside code blocks`);
  const plugin = json(path.join(PLUGIN, '.claude-plugin', 'plugin.json'));
  assert.ok(plugin.license || fs.existsSync(path.join(PLUGIN, 'LICENSE')), 'license in plugin.json or a LICENSE file');
  assert.match(plugin.name, /^[a-z0-9-]{1,64}$/);
});

test("the setup skill names only real pocp commands, and keeps approvals the user's", () => {
  const skill = fs.readFileSync(path.join(PLUGIN, 'skills', 'setup', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: setup\ndescription: .+\n---\n/);
  const commands = new Set([...skill.matchAll(/`(?:npx )?pocp ([a-z]+)/g)].map((m) => m[1]));
  assert.ok(commands.has('init') && commands.has('doctor') && commands.has('fix'), [...commands].join(','));
  for (const cmd of commands) {
    if (cmd === 'approve') continue; // named only under "Never"
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'pocp.js'), cmd, '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `pocp ${cmd} --help: ${r.stderr}`);
  }
  const never = skill.slice(skill.indexOf('**Never**'));
  for (const s of ['pocp-approve-', 'pocp approve', '--accept-', '--no-verify', 'core.hooksPath']) assert.ok(never.includes(s), s);
});

test('the setup skill has the user confirm the first rule and treats an uncovered rule as a mistake', () => {
  const skill = fs.readFileSync(path.join(PLUGIN, 'skills', 'setup', 'SKILL.md'), 'utf8');
  assert.match(skill, /the user decides it, not you/);
  assert.match(skill, /confirm or correct it before you go on/);
  assert.match(skill, /matches no tracked file/);
});

test('the setup skill commits the dependency before the adoption branch, so the adoption PR carries only .proof/ and CI files', () => {
  const skill = fs.readFileSync(path.join(PLUGIN, 'skills', 'setup', 'SKILL.md'), 'utf8');
  const install = skill.indexOf('npm install --save-dev proof-of-change');
  const commitDep = skill.indexOf('git commit -m "Add proof-of-change"');
  const branch = skill.indexOf('git checkout -b adopt-pocp');
  assert.ok(install >= 0 && commitDep >= 0 && branch >= 0, 'install, dependency commit and branch steps are all there');
  assert.ok(install < commitDep && commitDep < branch, 'install, then commit the dependency, then make the adoption branch');
  assert.match(skill, /only `\.proof\/` and CI files/);
});
