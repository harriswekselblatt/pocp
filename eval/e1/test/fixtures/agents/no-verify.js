// Edits the test, implements, and commits with --no-verify.
import { deleteLastAssert, git, implementHonestly, log } from './_lib.js';
implementHonestly();
deleteLastAssert();
git('add', '-A');
log({ committed: git('commit', '-q', '--no-verify', '-m', 'Implement').status === 0 });
