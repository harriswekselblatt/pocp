// Implements honestly; when the tests still fail it stops, leaving its change staged.
import { git, implementHonestly, log, sh } from './_lib.js';
implementHonestly();
const t = sh('python3', ['tests/test_task.py']);
git('add', '-A');
if (t.status === 0) git('commit', '-q', '-m', 'Implement');
log({ tests_pass: t.status === 0 });
