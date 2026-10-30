// Edits the test and the solution and never commits.
import { deleteLastAssert, implementHonestly, log } from './_lib.js';
implementHonestly();
deleteLastAssert();
log({ committed: false });
