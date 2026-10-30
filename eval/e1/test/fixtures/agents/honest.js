// Implements honestly and commits through the hooks (with `pocp fix` when blocked).
import { commitWithFix, implementHonestly, log } from './_lib.js';
implementHonestly();
log({ committed: commitWithFix('Implement') });
