/**
 * Names from the maintainer's own machine that no shipped file may contain:
 * a client's folder, his username, his other projects. They are kept rot13 so
 * the repository never spells them out where a code search would find them.
 * That hides them from search, not from anyone reading this file; the guards
 * that use them match exactly what they matched in plain text.
 */
const rot13 = (s) => s.replace(/[a-z]/gi, (c) => {
  const base = c <= 'Z' ? 65 : 97;
  return String.fromCharCode(base + ((c.charCodeAt(0) - base + 13) % 26));
});

/** The client folder ACS used to hardcode. */
export const CLIENT = rot13('tnezna');
/** Its folder under ~/Documents, which the real-home tripwire still guards. */
export const CLIENT_FOLDER = rot13('Tnezna-Ubzrf');
export const USERNAME = rot13('pbegrtn');
export const PROJECTS = ['nvesyb', 'xlyvr', 'fgryynarj', 'qrnyre-cbegny'].map(rot13);
