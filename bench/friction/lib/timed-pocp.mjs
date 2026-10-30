#!/usr/bin/env node
// Stands in for pocp inside git hooks (POCP_BIN): runs the real CLI, passes its output and
// exit code through, and appends "<command> <ms> <exit>" to $FRICTION_LOG.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const [, , cli, ...args] = process.argv;
const started = process.hrtime.bigint();
const r = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' });
const ms = Number((process.hrtime.bigint() - started) / 1000000n);
if (process.env.FRICTION_LOG) fs.appendFileSync(process.env.FRICTION_LOG, `${JSON.stringify({ cmd: args[0], ms, exit: r.status })}\n`);
process.exit(r.status ?? 1);
