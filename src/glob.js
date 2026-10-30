// Small glob matcher: `**` crosses folders, `*` and `?` stay within one path segment.
// A pattern with no wildcard matches that exact path, or anything under it if it ends with "/".

const cache = new Map();

export function globToRegExp(glob) {
  if (cache.has(glob)) return cache.get(glob);
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?'; // "**/" matches zero or more folders
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$+.()|{}[]'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  if (glob.endsWith('/')) re += '.*';
  const compiled = new RegExp(`^${re}$`);
  cache.set(glob, compiled);
  return compiled;
}

export function isGlob(pattern) {
  return /[*?]/.test(pattern) || pattern.endsWith('/');
}

export function matchGlob(path, glob) {
  if (!glob || !path) return false;
  if (!isGlob(glob)) return path === glob;
  return globToRegExp(glob).test(path);
}

export function matchAny(path, globs = []) {
  return globs.some((g) => matchGlob(path, g));
}

/**
 * Why a glob can't mean what it looks like, or null. POCP's dialect has `**`, `*` and `?`
 * only; braces and character classes are matched literally, so they would silently match
 * nothing.
 */
export function globProblem(glob) {
  if (typeof glob !== 'string' || !glob) return 'must be a non-empty string';
  if (/[{}]/.test(glob)) return `"${glob}" uses { } (brace expansion), which POCP does not support; list each pattern separately`;
  if (/[[\]]/.test(glob)) return `"${glob}" uses [ ] (character classes), which POCP does not support`;
  if (glob.startsWith('./')) return `"${glob}" starts with "./"; write it relative to the repository root without it`;
  if (glob.startsWith('/')) return `"${glob}" is absolute; write it relative to the repository root`;
  if (glob.split('/').includes('..')) return `"${glob}" points outside the repository`;
  return null;
}
