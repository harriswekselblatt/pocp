// Every block explains itself: what is wrong, why it matters, and the exact next step.
// A remedy is { code, what, why, next, by } where `by` says who can take the step:
//   "pocp fix"  mechanical; `pocp fix` does it
//   "agent"     the author changes code or files, then runs `pocp fix` again
//   "person"    only a person can approve it (never the agent that made the change)

export const APPROVE_TESTS_LABEL = 'pocp-approve-tests';
export const APPROVE_POLICY_LABEL = 'pocp-approve-policy';
export const APPROVE_INCONCLUSIVE_LABEL = 'pocp-approve-inconclusive';

/** Said with every block that needs a person. Rewriting history never clears an approval. */
export const DONT_REWRITE = 'Do not squash, force-push, rewrite history or commit with --no-verify to get past this: push the commit as it is and ask for the approval.';

const list = (xs, n = 6) => (xs.length > n ? `${xs.slice(0, n).join(', ')} and ${xs.length - n} more` : xs.join(', '));

/** Why a set of files needs a packet, in the gate's own words. */
function whyPacket(reasons, files) {
  const hit = reasons.filter((r) => (r.files || []).some((f) => files.includes(f)));
  const parts = hit.map((r) => {
    if (r.code === 'requirement') return 'a rule requires checks for them';
    if (r.code === 'glob') return 'they match protected paths';
    if (r.code === 'broad') return r.detail;
    if (r.code === 'cross_area') return r.detail;
    if (r.code === 'policy_change') return 'they are POCP policy, which decides what every later change must prove';
    if (r.code === 'ci_config') return 'CI configuration can switch verification off';
    if (r.code === 'test_change') return 'existing tests or test setup changed, which can hide a bug instead of fixing it';
    return r.detail;
  });
  return parts.length ? `${[...new Set(parts)].join('; ')}.` : 'the rules in .proof/rules.json say these files need proof.';
}

/** Remedies for a gate result (engine.gate), in the order to take them. */
export function gateRemedies(r) {
  if (r.decision === 'pass') return [];
  const out = [];
  if (r.decision === 'error') {
    for (const p of r.problems) {
      out.push({ code: p.code, what: p.detail, why: 'POCP cannot judge any change while its rules or config are invalid.', next: 'edit .proof/rules.json or .proof/config.json until "pocp rules check" passes', by: 'agent' });
    }
    return out;
  }
  for (const p of r.problems.filter((x) => x.code === 'prove_failed')) {
    const clean = /clean mode refused/.test(p.detail);
    out.push({
      code: p.code,
      what: p.detail,
      why: clean ? 'clean mode proves the working folder, so it must match what is staged.' : 'the checks could not run.',
      next: clean ? 'pocp fix (proves a snapshot of exactly what is staged)' : 'pocp fix',
      by: clean ? 'pocp fix' : 'agent',
    });
  }
  if (r.unpacketed?.length) {
    out.push({
      code: 'no_packet',
      what: `${r.unpacketed.length} staged file(s) are not covered by any packet: ${list(r.unpacketed)}`,
      why: `${whyPacket(r.reasons, r.unpacketed)} A packet records what the change is and the checks that prove it.`,
      next: 'pocp fix --intent "<what this change does>"',
      by: 'pocp fix',
    });
  }
  for (const p of r.packets || []) {
    const ev = p.evaluation;
    if (ev.ok && p.packet_file_staged !== false) continue;
    if (ev.ok) {
      out.push({ code: 'packet_not_staged', what: `${p.id} is proven but its file is not staged`, why: 'the proofs travel inside the commit, so CI can check them.', next: `pocp fix (or git add .proof/packets/${p.id}.json)`, by: 'pocp fix' });
      continue;
    }
    if (ev.missing_required.length) {
      out.push({ code: 'missing_required', what: `${p.id} lacks checks the rules now require: ${ev.missing_required.map((m) => m.id).join(', ')}`, why: 'the rules changed after the packet was opened.', next: `pocp fix (or pocp sync ${p.id})`, by: 'pocp fix' });
    }
    if (ev.failed.length) {
      out.push({
        code: 'failed_proof',
        what: `${p.id}: ${ev.failed.join(', ')} failed on this exact code`,
        why: 'a required check fails, so the change would break what it protects.',
        next: 'fix the code (not the tests), stage it, then pocp fix. The log path is in "pocp show" or the prove output.',
        by: 'agent',
      });
    }
    if (ev.unproven.length) {
      out.push({ code: 'unproven', what: `${p.id}: no proof yet for this code (${ev.unproven.join(', ')})`, why: 'proofs are tied to the exact staged code; anything staged since the last prove needs a new one.', next: `pocp fix (or pocp prove ${p.id})`, by: 'pocp fix' });
    }
    const guardIds = new Set((ev.guard || []).map((x) => x.id));
    for (const g of (ev.guard || []).filter((x) => ev.unattested.includes(x.id))) {
      const block = r.guard_mode === 'block';
      out.push({
        code: 'test_change',
        what: `${p.id}: the test-change check did not pass: ${g.detail || g.status}`,
        why: 'existing tests changed and POCP could not show they still catch what they caught before; changed tests can hide a bug instead of fixing it.',
        next: block
          ? `pocp fix (hands it to CI, where a maintainer approves it with the \`${APPROVE_TESTS_LABEL}\` label; the author can't sign off on its own test change)`
          : `a person who reviewed the test change runs: pocp attest ${p.id} ${g.id} --by <their name>`,
        by: block ? 'pocp fix' : 'person',
      });
    }
    const manual = ev.unattested.filter((x) => !guardIds.has(x));
    if (manual.length) {
      out.push({ code: 'unattested', what: `${p.id}: needs a sign-off: ${manual.join(', ')}`, why: 'these obligations are checks only a person can do.', next: `the person who did each check runs: pocp attest ${p.id} <obligation> --by <their name>`, by: 'person' });
    }
  }
  for (const p of r.problems.filter((x) => x.code !== 'prove_failed' && x.code !== 'failed_proof' && x.code !== 'packet_not_staged')) {
    out.push({ code: p.code, what: p.detail, why: 'the gate cannot pass until this is resolved.', next: 'pocp fix', by: 'agent' });
  }
  for (const w of (r.warnings || []).filter((x) => x.code === 'draft_packet')) {
    out.push({ code: 'draft_packet', what: w.detail, why: 'a draft covers nothing until it is ready.', next: w.detail.match(/"(pocp ready [^"]+)"/)?.[1] || 'pocp ready <packet>', by: 'agent' });
  }
  return out;
}

/** Notes for a passing gate that CI will still need a person for (block mode). */
export function pendingApprovals(r) {
  return (r.warnings || []).filter((w) => w.code === 'awaiting_test_approval' || w.code === 'awaiting_policy_approval').map((w) => (w.code === 'awaiting_test_approval'
    ? {
        code: 'test_change',
        what: w.detail,
        why: 'the test-change check did not pass, and in block mode only a maintainer can accept that.',
        next: `a maintainer adds the \`${APPROVE_TESTS_LABEL}\` label to the pull request`,
        by: 'person',
      }
    : {
        code: 'policy_change',
        what: w.detail,
        why: 'a change cannot approve a loosening of the rules that judge it.',
        next: `a maintainer adds the \`${APPROVE_POLICY_LABEL}\` label to the pull request`,
        by: 'person',
      }));
}

/** The remedy for one blocking verify finding (CI). */
export function verifyRemedy(code, detail = '') {
  switch (code) {
    case 'test_change':
      if (/passed only locally/.test(detail)) return { why: 'a local pass can be faked; CI must see the check pass itself.', next: 'run verify with --rerun or --rerun-unsigned (the Action does by default)', by: 'agent' };
      if (/checks the packet chose/.test(detail)) return { why: 'the check must run tests a rule requires, not ones the change picked.', next: 'add a requirement in .proof/rules.json covering these tests (a policy change a maintainer approves)', by: 'person' };
      return { why: 'existing tests changed and POCP could not show they still catch what they caught before.', next: `a maintainer reviews the test change and adds the \`${APPROVE_TESTS_LABEL}\` label`, by: 'person' };
    case 'test_inconclusive':
      return { why: 'existing tests changed and the check that judges them didn\'t finish (a timeout, a kill or a failed start), so nothing is known about them yet. A test approval doesn\'t cover this.', next: `re-run the job; if it still can't finish, fix the hang or the time limit, or a maintainer who has read why adds the \`${APPROVE_INCONCLUSIVE_LABEL}\` label`, by: 'person' };
    case 'policy_loosened':
    case 'ci_config_changed':
      return { why: 'this change loosens the rules or CI that judge every later change; the change cannot approve itself.', next: `a maintainer reviews it and adds the \`${APPROVE_POLICY_LABEL}\` label`, by: 'person' };
    case 'invalid_policy':
      return { why: 'POCP cannot judge anything under an invalid policy.', next: 'fix .proof/rules.json or .proof/config.json until "pocp rules check" passes, in a new commit', by: 'agent' };
    case 'ci_unfinished':
      return { why: "a required CI check didn't finish when verify re-ran it (it timed out or was killed), so nothing is known about the code yet.", next: 're-run the job; if it still can\'t finish, fix the hang or raise the time limit', by: 'agent' };
    case 'ci_missing':
    case 'ci_failed':
      return { why: 'verify.require_ci lists checks CI must run on this exact code.', next: code === 'ci_failed' ? 'fix the code (not the tests) in a new commit' : 'run verify with --rerun, which runs the required checks itself (see examples/github/pocp.yml)', by: 'agent' };
    case 'rerun_failed':
      if (/, timed out\)/.test(detail)) return { why: "a required check didn't finish when verify re-ran it (it timed out), so nothing is known about the code yet.", next: 're-run the job; if it still can\'t finish, fix the hang or raise the time limit', by: 'agent' };
      // falls through: a check that ran and failed
    case 'failed_proof':
      return { why: 'a required check fails on this code.', next: 'fix the code (not the tests) and commit the fix with "pocp fix" then "git commit"', by: 'agent' };
    case 'trailer_mismatch':
      return { why: 'the commit\'s code is not the code that was proven; this happens after a rebase or an edit after proving.', next: 'ask a maintainer how to update this branch; to bring in main, use git merge rather than rebase so proofs stay valid', by: 'person' };
    case 'uncovered':
    case 'missing_packet':
    case 'unproven':
    case 'missing_required':
    case 'unattested':
      return { why: 'this commit was made without the proof its files need (were the hooks skipped or not installed? see "pocp doctor").', next: 'ask a maintainer how to repair the commit; for new commits run "pocp fix" before "git commit"', by: 'person' };
    case 'policy_mismatch':
      return { why: 'the packet was proven under different rules than the ones in force.', next: 'pocp fix, then commit again', by: 'agent' };
    case 'invalid_signature':
      return { why: 'a proof was edited after signing, or its signer is not trusted.', next: 'prove again with a trusted key (pocp fix) in a new commit', by: 'agent' };
    default:
      return { why: '', next: 'pocp fix', by: 'agent' };
  }
}

/** Human lines for a list of remedies. */
export function remedyLines(remedies, indent = '  ') {
  const lines = [];
  for (const r of remedies) {
    lines.push(`${indent}what: ${r.what}`);
    if (r.why) lines.push(`${indent}  why: ${r.why}`);
    lines.push(`${indent}  next: ${r.next}${r.by === 'person' ? '   (needs a person)' : ''}`);
  }
  if (remedies.some((r) => r.by === 'person')) lines.push(`${indent}${DONT_REWRITE}`);
  return lines;
}
