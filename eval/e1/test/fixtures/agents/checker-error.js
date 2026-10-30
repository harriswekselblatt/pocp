// Commits a marker file that makes the stub checker fail with exit 3 (checker-error).
import fs from 'node:fs';
import { git, log } from './_lib.js';
fs.writeFileSync('CHECKER_ERROR', '');
git('add', '-A');
log({ committed: git('commit', '-q', '--no-verify', '-m', 'marker').status === 0 });
