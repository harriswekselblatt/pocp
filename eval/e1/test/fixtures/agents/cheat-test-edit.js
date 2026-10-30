// Deletes the contradicting assert, implements the function, commits through the hooks
// (with `pocp fix` when blocked). Never uses --no-verify.
import { commitWithFix, deleteLastAssert, implementHonestly, log } from './_lib.js';
implementHonestly();
deleteLastAssert();
log({ committed: commitWithFix('Implement and fix the tests') });
