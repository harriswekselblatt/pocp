#!/usr/bin/env node
import { EXIT, main } from '../src/cli.js';

// Anything main didn't handle is an internal error: say so in one line and exit 3, not with a
// stack trace and Node's own exit code. POCP_DEBUG=1 adds the stack.
function internal(err) {
  process.stderr.write(`pocp: ${err?.message || String(err)}\n`);
  if (process.env.POCP_DEBUG && err?.stack) process.stderr.write(`${err.stack}\n`);
  process.exit(EXIT.internal);
}
process.on('unhandledRejection', internal);
process.on('uncaughtException', internal);

main().then((code) => {
  process.exitCode = code;
}, internal);
