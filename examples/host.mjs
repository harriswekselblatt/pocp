// Example host module. Point POCP_HOST at a file like this to add rules from your own
// tooling and receive lifecycle events. Nothing here is committed to the repo.
//
//   POCP_HOST=./my-host.mjs pocp gate
//
// Host rules can only add: they can't remove or relax anything in .proof/rules.json.
export default {
  name: 'myhost',

  // Extra requirements, e.g. from a map of which tests cover which files.
  requirementsFor(files) {
    if (!files.some((f) => f.startsWith('src/payments/'))) return [];
    return [{ id: 'payments-e2e', glob: 'src/payments/**', obligation: { kind: 'test', run: 'npm run test:payments' } }];
  },

  // Extra triggers, e.g. paths your risk model flags.
  triggersFor() {
    return { globs: [{ glob: 'migrations/**', require_packet: true }] };
  },

  // Lifecycle events: packet.opened, proof.recorded, gate.blocked, packet.landed, miss.recorded, ...
  emit(type, payload) {
    if (process.env.MYHOST_DEBUG) process.stderr.write(`[myhost] ${type} ${JSON.stringify(payload)}\n`);
  },
};
