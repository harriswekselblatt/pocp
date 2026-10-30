import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Load an optional host module (POCP_HOST env var or --host). A host module lets your
 * own tooling supply extra rules (Policy) and receive lifecycle events (Events) without
 * anything being committed to the repo.
 *
 * The module's default export (or the module itself) may provide:
 *   name: string
 *   requirementsFor(files, ctx) -> Requirement[]
 *   triggersFor(files, ctx)     -> { globs, broad_files?, cross_area? }
 *   emit(type, payload)
 */
export async function loadHost(spec) {
  if (!spec) return null;
  const url = spec.startsWith('file:') ? spec : pathToFileURL(path.resolve(spec)).href;
  const mod = await import(url);
  const host = mod.default || mod;
  const name = typeof host.name === 'string' && host.name ? host.name : 'host';
  return {
    name,
    policy: {
      name,
      requirementsFor: typeof host.requirementsFor === 'function' ? host.requirementsFor.bind(host) : undefined,
      triggersFor: typeof host.triggersFor === 'function' ? host.triggersFor.bind(host) : undefined,
    },
    events: typeof host.emit === 'function' ? { emit: host.emit.bind(host) } : undefined,
  };
}
