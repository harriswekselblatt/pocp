// pocp ci: moved from src/cli.js unchanged; main() dispatches here.
import { EXIT } from '../errors.js';
import { LIVE_VARIABLE, STATUS_CHECK, applyGithubProtection, checkGithubProtection, goLive, requiredChecksPlan } from '../ci-github.js';
import { UsageError } from '../cli-args.js';
import { applyFailureMessage, out } from '../cli/shared.js';

export async function run({ engine, flags, json, rest }) {
  if (rest[0] !== 'required') throw new UsageError('usage: pocp ci required [--check | --apply]');
  const plan = requiredChecksPlan(engine.root, engine.config());
  plan.github = (await import('../ci-github.js')).protectionPayload(null, plan).payload;
  if (flags.check) {
    // Read-only. A pull request can remove POCP from its own workflow; only a required
    // check that never reports blocks that merge.
    const r = checkGithubProtection(engine.root, plan);
    const where = r.repo ? `${r.repo}@${r.branch}` : r.branch;
    const human = r.error
      ? `could not read branch protection for ${where}: ${r.error}`
      : r.ok
        ? `${where} enforces the plan: ${plan.required_checks.join(', ')} must pass before a merge`
        : [`${where} does not enforce the plan:`, ...r.gaps.map((x) => `  - ${x}`), '  A pull request that drops POCP from its workflow can merge. Fix with: pocp ci required --apply (or in Settings → Branches)'].join('\n');
    out(json, { plan, result: r }, human);
    return r.ok ? EXIT.ok : r.error ? EXIT.usage : EXIT.blocked;
  }
  if (!flags.apply) {
    out(json, { plan }, [
      `branch ${plan.branch}: ${plan.require_pull_request ? 'changes arrive through pull requests' : 'direct pushes allowed'}${plan.enforce_admins ? ', admins included' : ''}`,
      plan.required_checks.length ? `required checks: ${plan.required_checks.join(', ')}` : 'required checks: none configured (set ci.required_checks in .proof/config.json). Until the job that runs pocp verify is required, a pull request that removes it from the workflow merges anyway.',
      'apply on GitHub with: pocp ci required --apply; check it with: pocp ci required --check   (other hosts: configure the same checks in their branch settings)',
    ].join('\n'));
    return EXIT.ok;
  }
  if (plan.required_checks.includes(STATUS_CHECK)) {
    // The pocp status: require it in place of the verify job and turn it on, together.
    const g = goLive(engine.root, plan, { protect: true });
    const p = g.protection;
    const human = [
      ...(p?.ok ? [`branch protection set on ${p.repo}@${p.branch}${p.was_protected ? ' (existing protection kept)' : ''}`, `  added required checks: ${p.added_checks.join(', ') || 'none (already required)'}`, ...(p.removed_checks.length ? [`  no longer required: ${p.removed_checks.join(', ')} (the "${STATUS_CHECK}" status replaces it)`] : []), ...(p.kept_checks.length ? [`  also still required (set elsewhere): ${p.kept_checks.join(', ')}`] : [])] : []),
      g.ok ? `${LIVE_VARIABLE} is on: a pull request waiting for approval shows a yellow "${STATUS_CHECK}" status, not a red failure` : p && !p.ok ? applyFailureMessage(p, plan) : `not turned on: ${g.error}`,
      ...(g.notes || []).map((n) => `  ${n}`),
    ].join('\n');
    out(json, { plan, result: g }, human);
    return g.ok ? EXIT.ok : EXIT.blocked;
  }
  const r = applyGithubProtection(engine.root, plan);
  const human = r.ok
    ? [
        `branch protection set on ${r.repo}@${r.branch}${r.was_protected ? ' (existing protection kept)' : ''}`,
        `  added required checks: ${r.added_checks.join(', ') || 'none (already required)'}`,
        ...(r.kept_checks.length ? [`  also still required (set elsewhere): ${r.kept_checks.join(', ')}`] : []),
      ].join('\n')
    : applyFailureMessage(r, plan);
  out(json, { plan, result: r }, human);
  return r.ok ? EXIT.ok : r.refused ? EXIT.usage : EXIT.blocked;
}
