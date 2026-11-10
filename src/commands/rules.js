// pocp rules: moved from src/cli.js unchanged; main() dispatches here.
import { EXIT } from '../errors.js';
import { UsageError } from '../cli-args.js';
import { out } from '../cli/shared.js';
import { policyKeyWarnings } from '../schema.js';
import { ruleWarnings, validateRules } from '../rules.js';
import { validateConfig } from '../store.js';

export async function run({ engine, json, rest }) {
  if (rest[0] !== 'check') throw new UsageError('usage: pocp rules check');
  const rawRules = engine.store.readRawRules();
  const problems = [
    ...validateRules(rawRules || {}),
    ...validateConfig(engine.config()).map((p) => `config: ${p}`),
  ];
  const warnings = [...policyKeyWarnings({ rules: rawRules, config: engine.store.readRawConfig?.() }), ...ruleWarnings(engine.rules(), engine.root)];
  out(json, { ok: problems.length === 0, problems, warnings }, [
    ...(problems.length ? problems.map((p) => `rules: ${p}`) : ['rules: ok']),
    ...warnings.map((w) => `warning: ${w}`),
  ].join('\n'));
  return problems.length ? EXIT.usage : EXIT.ok;
}
