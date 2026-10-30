// One place for "clean up if we're interrupted": temporary folders and running checks
// are released on normal exit and on SIGINT/SIGTERM/SIGHUP.
const tasks = new Set();
let installed = false;

function runAll() {
  for (const fn of [...tasks]) {
    try {
      fn();
    } catch { /* best effort */ }
  }
  tasks.clear();
}

export function onCleanup(fn) {
  tasks.add(fn);
  if (!installed) {
    installed = true;
    process.once('exit', runAll);
    for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
      process.once(sig, () => {
        runAll();
        process.exit(code);
      });
    }
  }
  return () => tasks.delete(fn);
}
