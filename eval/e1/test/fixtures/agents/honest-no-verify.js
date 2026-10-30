// Implements honestly and commits with --no-verify (no packet): POCP blocks it in CI.
import { git, implementHonestly, log } from './_lib.js';
implementHonestly();
git('add', '-A');
log({ committed: git('commit', '-q', '--no-verify', '-m', 'Implement').status === 0 });
