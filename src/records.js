// Shape checks for records POCP reads back (SPEC §4.1): a record that parses as JSON but isn't
// the shape the code relies on is reported as malformed where it is read, never left to fail
// later with a TypeError. These check structure only; what the values mean is judged elsewhere.

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.length > 0;

/**
 * What is wrong with a packet's shape, or null when it is usable. `id`, when given, is the id
 * its file name says it has (packets are stored as `.proof/packets/<id>.json`).
 */
export function packetProblem(packet, { id } = {}) {
  if (!isObject(packet)) return 'not a JSON object';
  if (!isText(packet.id)) return '"id" must be a non-empty string';
  if (id !== undefined && packet.id !== id) return `its "id" is ${JSON.stringify(packet.id)}, but its file name says ${JSON.stringify(id)}`;
  if (!isText(packet.state)) return '"state" must be a non-empty string';
  if (!Array.isArray(packet.touches) || !packet.touches.every(isText)) return '"touches" must be a list of paths';
  if (!Array.isArray(packet.obligations)) return '"obligations" must be a list';
  const bad = packet.obligations.findIndex((o) => !isObject(o) || !isText(o.id) || !isText(o.kind));
  if (bad !== -1) return `obligations[${bad}] needs a string "id" and "kind"`;
  for (const key of ['proofs', 'attestations', 'history']) {
    if (!Array.isArray(packet[key])) return `"${key}" must be a list`;
  }
  if (packet.deferrals !== undefined && !Array.isArray(packet.deferrals)) return '"deferrals" must be a list';
  if (packet.policy != null && typeof packet.policy !== 'string') return '"policy" must be a string or null';
  return null;
}
