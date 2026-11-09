// Policy as committed at a revision: the rules and config (readJsonAt, readRulesAt, policyAt,
// notEnrolled), the policy that judges a commit (policyInForce), the exception list
// (readUncoveredExceptions, applyUncoveredExceptions, acceptedText), and which CI definition
// files a change touched (changedCiFiles).
import fs from 'node:fs';
import * as g from '../git.js';
import { rulesWithDefaults, validateConfig, withDefaults } from '../store.js';
import { matchGlob } from '../glob.js';
import { validateRules } from '../rules.js';
import { blockingRule, combinePolicy, EXCEPTIONS_FILE, POLICY_FILES, policyLoosenings } from '../policy.js';
import { policyKeyWarnings } from '../schema.js';

/** Policy readers for one repository at `root`. */
export function createPolicyAt({ root }) {
  function readRulesAt(rev) {
    if (!g.hasHead(root) && rev === 'HEAD') return null;
    const raw = g.showFile(root, rev, '.proof/rules.json');
    if (raw === null) return null;
    try {
      return rulesWithDefaults(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /**
   * Rules and config as committed at `rev`, with every problem that makes them unusable:
   * unreadable JSON or values that don't validate. verify fails closed on any problem.
   */
  function policyAt(rev) {
    // All four policy files in one git call; policyInForce reads the other two right after.
    g.prefetchFilesAt(root, rev, POLICY_FILES);
    const problems = [];
    const rawRules = readJsonAt(rev, '.proof/rules.json');
    const rawCfg = readJsonAt(rev, '.proof/config.json');
    if (rawRules?.__invalid) problems.push(`.proof/rules.json at ${rev.slice(0, 12)} is not valid JSON`);
    if (rawCfg?.__invalid) problems.push(`.proof/config.json at ${rev.slice(0, 12)} is not valid JSON`);
    const rulesObj = rulesWithDefaults(rawRules && !rawRules.__invalid ? rawRules : {});
    const cfgObj = withDefaults(rawCfg && !rawCfg.__invalid ? rawCfg : {});
    if (rawRules && !rawRules.__invalid) for (const p of validateRules(rawRules)) problems.push(`rules at ${rev.slice(0, 12)}: ${p}`);
    if (rawCfg && !rawCfg.__invalid) for (const p of validateConfig(cfgObj)) problems.push(`config at ${rev.slice(0, 12)}: ${p}`);
    // Not yet enrolled: git itself lists no policy file at this commit. A read that failed is
    // not this (ls-tree returns null on error, '' when the files are absent).
    const unenrolled = rawRules === null && rawCfg === null
      && g.git(root, ['ls-tree', '--name-only', rev, '--', ...POLICY_FILES], { allowFail: true }) === '';
    // Keys POCP doesn't know are ignored: a warning, never a problem (src/schema.js).
    const keyWarnings = policyKeyWarnings({ rules: rawRules?.__invalid ? null : rawRules, config: rawCfg?.__invalid ? null : rawCfg });
    return { rules: rulesObj, config: cfgObj, hasRules: Boolean(rawRules && !rawRules.__invalid), problems, unenrolled, keyWarnings };
  }

  /** No revision, or one where git lists no policy file: POCP isn't enrolled there yet. */
  function notEnrolled(rev) {
    return !rev || policyAt(rev).unenrolled;
  }

  function readJsonAt(rev, rel) {
    const raw = g.showFile(root, rev, rel);
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return { __invalid: true };
    }
  }

  /**
   * The policy that judges `commit`: the base's rules, config and signers, strictly combined
   * with the commit's (a change can't loosen what judges it), unless a loosening is accepted.
   * Which findings fail is the repo's choice (verify.fail_on) in that policy; an invalid
   * policy always fails.
   */
  function policyInForce(commit, baseRev, { acceptPolicyChange = false, allowedSignersFile } = {}) {
    const headPolicy = policyAt(commit);
    const headRules = headPolicy.rules;
    // A base git shows with no policy at all is a repository adopting POCP: nothing to loosen,
    // and the commit's own policy is the first one. (A base whose policy can't be read is not
    // this: policyAt only reports `unenrolled` when git lists no policy file there.)
    const atBase = baseRev ? policyAt(baseRev) : null;
    const basePolicy = atBase && !atBase.unenrolled ? atBase : null;
    const baseRules = basePolicy?.hasRules ? basePolicy.rules : null;
    const policyProblems = [...headPolicy.problems, ...(basePolicy?.problems || [])];
    const baseSigners = baseRev ? g.showFile(root, baseRev, '.proof/allowed_signers') : null;
    const headSigners = g.showFile(root, commit, '.proof/allowed_signers');
    // Rules always (an unenrolled base has none); config only against an enrolled base; signers
    // and the exception list (which waives missing proof) whenever there is a base.
    const weakened = policyLoosenings({
      rules: { base: baseRules, head: headRules },
      config: basePolicy ? { base: basePolicy.config, head: headPolicy.config } : undefined,
      signers: baseRev ? { base: baseSigners, head: headSigners } : undefined,
      exceptions: baseRev ? { base: g.showFile(root, baseRev, EXCEPTIONS_FILE), head: g.showFile(root, commit, EXCEPTIONS_FILE) } : undefined,
    });
    const accepted = Boolean(baseRev && weakened.length && acceptPolicyChange);
    const { rules: rulesAt, config: cfgAt } = combinePolicy({ base: basePolicy, head: headPolicy, accepted });
    let allowedSigners = basePolicy && !accepted ? baseSigners : headSigners;
    if (allowedSignersFile) allowedSigners = fs.readFileSync(allowedSignersFile, 'utf8');
    const { failOn, blocks } = blockingRule(cfgAt);
    return { policyProblems, weakened, accepted, rulesAt, cfgAt, allowedSigners, failOn, blocks, keyWarnings: headPolicy.keyWarnings };
  }

  /**
   * The exception list at `rev`: entries name one commit (full SHA) and exact files that
   * commit left without a packet, with a reason and a reviewer. Used only with an approval
   * for the head (acceptUncovered); an exception never turns missing proof into proof.
   */
  function readUncoveredExceptions(rev) {
    const raw = readJsonAt(rev, EXCEPTIONS_FILE);
    if (raw === null) return { entries: [], problems: [] };
    if (raw.__invalid || typeof raw !== 'object' || Array.isArray(raw)) return { entries: [], problems: [`${EXCEPTIONS_FILE} is not a valid JSON object`] };
    const list = raw.uncovered === undefined ? [] : raw.uncovered;
    if (!Array.isArray(list)) return { entries: [], problems: [`${EXCEPTIONS_FILE}: "uncovered" must be a list`] };
    const entries = [];
    const problems = [];
    list.forEach((e, i) => {
      const ok = e && typeof e === 'object' && /^[0-9a-f]{40}$/.test(e.commit || '')
        && Array.isArray(e.files) && e.files.length > 0 && e.files.every((f) => typeof f === 'string' && f.length > 0 && !/[*?[\]{}]/.test(f))
        && typeof e.reason === 'string' && e.reason.trim() !== '' && typeof e.reviewer === 'string' && e.reviewer.trim() !== '';
      if (ok) entries.push(e);
      else problems.push(`${EXCEPTIONS_FILE}: uncovered[${i}] needs "commit" (a full 40-character SHA), "files" (exact paths, no globs), "reason" and "reviewer"`);
    });
    return { entries, problems };
  }

  /** Split uncovered files into those an exception names for this commit and the rest. */
  function applyUncoveredExceptions(files, exceptions, matches) {
    const accepted = [];
    const rest = [];
    for (const f of files) {
      const e = exceptions ? exceptions.entries.find((x) => matches(x, f)) : null;
      if (e) accepted.push({ file: f, commit: e.commit, reason: e.reason, reviewer: e.reviewer });
      else rest.push(f);
    }
    return { accepted, rest };
  }

  const acceptedText = (a, head) => `UNPROVEN: ${a.file} has no packet in commit ${a.commit.slice(0, 12)}; accepted as a reviewed exception for head ${head.slice(0, 12)} by ${a.reviewer}: ${a.reason}`;

  /** CI definition files a change touched (ci.files globs). */
  function changedCiFiles(changes, cfg) {
    const globs = cfg.ci?.files || [];
    const touched = new Set();
    for (const c of changes) for (const p of [c.path, c.oldPath]) if (p && globs.some((gl) => matchGlob(p, gl))) touched.add(p);
    return [...touched].sort();
  }

  return { readJsonAt, readRulesAt, policyAt, notEnrolled, policyInForce, readUncoveredExceptions, applyUncoveredExceptions, acceptedText, changedCiFiles };
}
