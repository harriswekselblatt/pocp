import * as P from './packets.js';
import { DONT_REWRITE } from './remedies.js';

const MAX_ROUNDS = 4;

/** The check to use when no rule names one for these files: --test, then the repo's own. */
export function fallbackCheck(engine, test) {
  if (test) return { run: test, from: '--test' };
  const cfg = engine.config();
  const ci = cfg.verify?.require_ci?.[0];
  if (ci) return { run: ci, from: 'verify.require_ci in .proof/config.json' };
  const counts = new Map();
  for (const r of engine.rules().requirements || []) {
    const run = r.obligation?.kind === 'test' ? r.obligation.run : null;
    if (run) counts.set(run, (counts.get(run) || 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best ? { run: best[0], from: 'the test command .proof/rules.json requires most often' } : null;
}

function defaultIntent(files) {
  const shown = files.slice(0, 3).join(', ');
  return `Change to ${shown}${files.length > 3 ? ` and ${files.length - 3} more` : ''}`;
}

/**
 * The packet `fix` widens instead of opening another: an active packet the same author opened
 * that already covers some of the staged files (the one they are working in).
 */
function packetToWiden(engine, gate, actor) {
  const staged = gate.files || [];
  const mine = engine.activePackets()
    .filter((p) => p.state !== 'draft' && p.opened_by === actor && staged.some((f) => P.covers(p, f)))
    .sort((a, b) => String(b.opened_at).localeCompare(String(a.opened_at)));
  return mine[0] || null;
}

/**
 * `pocp fix`: take every mechanical step the gate asks for, then say what is left and who
 * has to do it. It opens or widens a packet, adds required checks, proves (a snapshot of the
 * staged code when the working folder differs), and stages packet files. It never signs off
 * for anyone, and never re-runs a check that already failed on this exact code.
 */
export async function runFix(engine, { intent, test, mode, actor } = {}) {
  const actions = [];
  let gate = await engine.gate({ source: 'fix' });
  const proved = new Set();
  for (let round = 0; round < MAX_ROUNDS && gate.decision === 'blocked'; round++) {
    let progressed = false;
    if (gate.unpacketed.length) {
      const target = packetToWiden(engine, gate, actor);
      if (target) {
        const r = await engine.widen(target.id, gate.unpacketed);
        actions.push({ action: 'widen', packet: target.id, files: gate.unpacketed, checks_added: r.required_added.map((o) => o.id) });
      } else {
        const sug = gate.suggestion || (await engine.suggestPacket(gate.unpacketed));
        const obligations = [];
        let fallback = null;
        if (!sug.obligations.length) {
          fallback = fallbackCheck(engine, test);
          if (!fallback) break; // nothing to prove it with: reported below
          obligations.push({ kind: 'test', run: fallback.run });
        }
        const r = await engine.open({ intent: intent || defaultIntent(gate.unpacketed), touches: gate.unpacketed, obligations });
        actions.push({ action: 'open', packet: r.packet.id, files: gate.unpacketed, checks: r.packet.obligations.map((o) => (o.source && o.source !== 'author' ? `${o.id} (${o.source})` : o.id)), ...(fallback ? { check_from: fallback.from, check: fallback.run } : {}), ...(intent ? {} : { intent: r.packet.intent }) });
      }
      progressed = true;
      gate = await engine.gate({ source: 'fix' });
    }
    const stale = gate.packets.filter((p) => p.evaluation.missing_required.length);
    if (stale.length) {
      await engine.sync(stale.map((p) => p.id));
      actions.push({ action: 'sync', packets: stale.map((p) => p.id) });
      progressed = true;
    }
    const toProve = gate.packets.filter((p) => !p.evaluation.ok || p.evaluation.missing_required.length).map((p) => p.id).filter((id) => !proved.has(`${id}\0${gate.subject}`));
    if (toProve.length) {
      let r;
      let usedMode = mode;
      try {
        r = await engine.prove({ ids: toProve, mode, retryFailed: false });
      } catch (err) {
        if (mode || !/clean mode refused/.test(err.message)) throw err;
        usedMode = 'snapshot';
        r = await engine.prove({ ids: toProve, mode: 'snapshot', retryFailed: false });
        actions.push({ action: 'note', detail: 'the working folder differs from what is staged, so a snapshot of exactly the staged code was proven' });
      }
      for (const id of toProve) proved.add(`${id}\0${gate.subject}`);
      const ran = r.packets.flatMap((p) => p.runs.filter((x) => !x.skipped && !x.cached && !x.reused_from));
      actions.push({
        action: 'prove',
        packets: toProve,
        mode: usedMode || r.mode,
        ran: ran.length,
        checks: r.packets.reduce((n, p) => n + p.runs.length, 0),
        ms: ran.reduce((a, x) => a + (x.duration_ms || 0), 0),
        failed: r.packets.flatMap((p) => p.runs.filter((x) => x.passed === false || x.failed_before).map((x) => ({ packet: p.id, obligation: x.obligation, log: x.run_id ? `.proof/runs/${x.run_id}.log` : null, before: Boolean(x.failed_before) }))),
      });
      progressed = true;
    }
    // Block mode: a test change the check couldn't pass goes to a maintainer in CI. Recorded as
    // a hand-over, never as a sign-off: the author can't approve its own test change.
    if (gate.guard_mode === 'block') {
      const fresh = await engine.gate({ source: 'fix' });
      for (const p of fresh.packets.filter((x) => (x.evaluation.guard || []).some((gd) => x.evaluation.unattested.includes(gd.id) && gd.status !== 'unproven'))) {
        const d = engine.deferToCi(p.id);
        if (d.length) {
          actions.push({ action: 'defer', packet: p.id, obligations: d.map((x) => x.obligation) });
          progressed = true;
        }
      }
    }
    const unstaged = gate.problems.filter((p) => p.code === 'packet_not_staged');
    if (unstaged.length) {
      engine.stagePackets(unstaged.map((p) => p.packet));
      actions.push({ action: 'stage', packets: unstaged.map((p) => p.packet) });
      progressed = true;
    }
    if (!progressed) break;
    gate = await engine.gate({ source: 'fix' });
  }

  const remaining = gate.decision === 'pass' ? [] : gate.remedies;
  const needsPerson = [...remaining.filter((r) => r.by === 'person'), ...(gate.pending_approvals || [])];
  const needsAgent = remaining.filter((r) => r.by !== 'person');
  if (gate.decision === 'blocked' && gate.unpacketed.length && !actions.some((a) => a.action === 'open' || a.action === 'widen')) {
    needsAgent.unshift({ code: 'no_check', what: `no rule names a check for ${gate.unpacketed.join(', ')}`, why: 'a packet needs at least one check that proves the change.', next: 'pocp fix --test "<command that proves it>"', by: 'agent' });
  }
  // A failed test-change check handed to CI (now or by an earlier fix on this code) is the
  // maintainer's to decide, not the author's to fix.
  const handed = new Set();
  for (const p of gate.packets || []) {
    let packet = null;
    try { packet = engine.loadPacket(p.id); } catch { continue; }
    for (const ob of packet.obligations || []) if (P.currentDeferral(packet, ob, gate.subject)) handed.add(`${p.id}\0${ob.id}`);
  }
  for (const a of actions.filter((x) => x.action === 'defer')) for (const o of a.obligations) handed.add(`${a.packet}\0${o}`);
  for (const a of actions.filter((x) => x.action === 'prove')) {
    a.handed = a.failed.filter((f) => handed.has(`${f.packet}\0${f.obligation}`)).map((f) => f.obligation);
    for (const f of a.failed) {
      if (handed.has(`${f.packet}\0${f.obligation}`)) continue;
      needsAgent.unshift({
        code: 'failed_proof',
        what: `${f.obligation} fails on this exact code${f.before ? ' (it failed here before, so it was not run again)' : ''}${f.log ? ` · log ${f.log}` : ''}`,
        why: 'a required check fails, so the change would break what it protects.',
        next: 'fix the code (not the tests), stage it, and run pocp fix again',
        by: 'agent',
      });
    }
  }
  return {
    ok: gate.decision === 'pass',
    decision: gate.decision,
    nothing_staged: (gate.files || []).length === 0,
    actions,
    needs_agent: dedupe(needsAgent),
    needs_person: dedupe(needsPerson),
    advice: needsPerson.length ? DONT_REWRITE : null,
    gate,
  };
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((r) => {
    const k = `${r.code}\0${r.what}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Human output for a fix result. */
export function formatFix(r) {
  const lines = [];
  if (r.ok && r.nothing_staged) return 'pocp fix: nothing is staged; stage the change (git add) and run pocp fix again';
  const onlyTests = r.needs_person.length && r.needs_person.every((x) => x.code === 'test_change');
  const head = r.ok
    ? r.needs_person.length
      ? onlyTests ? 'pocp fix: committable now; CI will need a person (a maintainer) to approve the test change' : 'pocp fix: committable now; CI will need a person (see below)'
      : 'pocp fix: ready to commit (git commit)'
    : r.needs_person.length && !r.needs_agent.length ? 'pocp fix: needs a person' : 'pocp fix: needs you';
  lines.push(head);
  for (const a of r.actions) {
    if (a.action === 'open') lines.push(`  did: opened ${a.packet} for ${a.files.length} file(s) with checks ${a.checks.join(', ') || 'none'}${a.check_from ? ` (check "${a.check}" from ${a.check_from})` : ''}${a.intent ? `; intent "${a.intent}" (pass --intent to say what the change does)` : ''}`);
    else if (a.action === 'widen') lines.push(`  did: widened ${a.packet} to cover ${a.files.join(', ')}${a.checks_added.length ? `; required checks added: ${a.checks_added.join(', ')}` : ''}`);
    else if (a.action === 'sync') lines.push(`  did: added the checks the rules now require to ${a.packets.join(', ')}`);
    else if (a.action === 'prove') {
      const extra = `${a.ran ? `, ${Math.round(a.ms / 1000)}s` : ''}${a.mode === 'snapshot' ? ', snapshot of the staged code' : ''}`;
      if (!a.failed.length) lines.push(`  did: proved ${a.packets.join(', ')} (${a.ran} check(s) run${a.ran ? '' : '; nothing new to run'}${extra})`);
      else {
        // Say what passed and what didn't: a failed check is never counted as proved.
        const handed = a.handed || [];
        const failing = a.failed.map((f) => f.obligation).filter((o) => !handed.includes(o));
        const total = Math.max(a.checks ?? a.ran, a.failed.length);
        lines.push(`  did: proved ${total - a.failed.length} of ${total} check(s) for ${a.packets.join(', ')}${extra ? ` (${extra.slice(2)})` : ''}${handed.length ? `; ${handed.join(', ')} handed to CI` : ''}${failing.length ? `; ${failing.join(', ')} failed` : ''}`);
      }
    }
    else if (a.action === 'defer') lines.push(`  did: handed ${a.packet} ${a.obligations.join(', ')} to CI: a maintainer approves the test change there (no sign-off from you)`);
    else if (a.action === 'stage') lines.push(`  did: staged ${a.packets.map((id) => `.proof/packets/${id}.json`).join(', ')}`);
    else if (a.action === 'note') lines.push(`  note: ${a.detail}`);
  }
  for (const x of r.needs_agent) {
    lines.push(`  needs you: ${x.what}`);
    if (x.why) lines.push(`    why: ${x.why}`);
    lines.push(`    next: ${x.next}`);
  }
  for (const x of r.needs_person) {
    lines.push(`  needs a person: ${x.what}`);
    if (x.why) lines.push(`    why: ${x.why}`);
    lines.push(`    the one action: ${x.next}`);
  }
  if (r.advice) lines.push(`  ${r.advice}`);
  return lines.join('\n');
}
