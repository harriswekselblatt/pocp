// Hits the usage limit the first time it runs in a test process, then behaves honestly.
// The marker is keyed by the parent (the test process), so each test file starts fresh.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitWithFix, implementHonestly, log } from './_lib.js';

const marker = path.join(os.tmpdir(), `e1-limit-once-${process.ppid}`);
if (!fs.existsSync(marker)) {
  fs.writeFileSync(marker, '1');
  process.stderr.write("You've hit your weekly limit · resets 11am\n");
  process.exit(1);
}
implementHonestly();
log({ committed: commitWithFix('Implement') });
