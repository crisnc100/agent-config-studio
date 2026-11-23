export const CURSOR_SHELL_EVENT = 'beforeShellExecution'

const jsonObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export function readCursorConfig(path, bytes, event) {
  if (bytes == null) return { version: 1, hooks: {} }
  let doc
  try { doc = JSON.parse(bytes.toString('utf8')) }
  catch { throw new Error(`${path} is not valid JSON; fix it before changing the Cursor hook`) }
  if (!jsonObject(doc) || (Object.hasOwn(doc, 'hooks') && !jsonObject(doc.hooks))
    || (Object.hasOwn(doc.hooks ?? {}, event) && !Array.isArray(doc.hooks[event]))) {
    throw new Error(`${path} must be a JSON object with a hooks object and a ${event} array when those keys are present`)
  }
  return doc
}

export const shellCommand = (path) => /^[a-zA-Z0-9_./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`

export const cursorCommand = (command) => `${command} --cursor`

// A matcher or timeout can belong to another hook that calls the same launcher.
export const isCursorGuardEntry = (entry, command) => (entry?.command === command || entry?.command === cursorCommand(command))
  && Object.keys(entry).every((key) => key === 'command' || key === 'failClosed')

export function cursorGuardActive(doc, command) {
  const entries = doc.hooks?.[CURSOR_SHELL_EVENT]?.filter((entry) => isCursorGuardEntry(entry, command))
  return entries?.length === 1 && entries[0].command === cursorCommand(command) && entries[0].failClosed === true
}
