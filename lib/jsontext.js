/**
 * Edit one member of a JSON document in place, as text.
 *
 * JSON.parse + stringify rewrites every byte of whitespace and key order, and a
 * string replace of a quoted id also hits every other value that happens to
 * equal it. These edits touch only the span of the member they name, so every
 * other byte of the file is identical afterwards.
 */

function fail(msg) { throw new Error(`not valid JSON (${msg})`); }

/** Parse into a tree that remembers where each value and member sits. */
export function scan(text) {
  let i = 0;
  const ws = () => { while (i < text.length && /[ \t\n\r]/.test(text[i])) i++; };
  const string = () => {
    const start = i++;
    while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
    if (text[i] !== '"') fail('unterminated string');
    i++;
    return { start, end: i, value: JSON.parse(text.slice(start, i)) };
  };
  const value = () => {
    ws();
    const start = i;
    const c = text[i];
    if (c === '{') {
      i++;
      const members = [];
      ws();
      if (text[i] === '}') { i++; return { type: 'object', start, end: i, members }; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail(`expected a key at ${i}`);
        const key = string();
        ws();
        if (text[i] !== ':') fail(`expected ":" at ${i}`);
        i++;
        const v = value();
        members.push({ key: key.value, keyStart: key.start, value: v });
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return { type: 'object', start, end: i, members }; }
        fail(`expected "," or "}" at ${i}`);
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') { i++; return { type: 'array', start, end: i }; }
      for (;;) {
        value();
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return { type: 'array', start, end: i }; }
        fail(`expected "," or "]" at ${i}`);
      }
    }
    if (c === '"') { const s = string(); return { type: 'string', ...s }; }
    const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if (!m) fail(`unexpected character at ${i}`);
    i += m[0].length;
    return { type: 'literal', start, end: i };
  };
  const root = value();
  ws();
  if (i !== text.length) fail(`trailing content at ${i}`);
  return root;
}

export const member = (obj, key) => (obj?.type === 'object' ? obj.members.find((m) => m.key === key) : undefined) || null;

const splice = (text, start, end, insert) => text.slice(0, start) + insert + text.slice(end);

/** The indentation of the line holding `pos`. */
function indentAt(text, pos) {
  const line = text.lastIndexOf('\n', pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(line))[0];
}

/** Replace a member's value, keeping its key and everything around it. */
export function replaceValue(text, m, raw) {
  return splice(text, m.value.start, m.value.end, raw);
}

/**
 * Add `"key": raw` to an object: after `after` when given, else as the last
 * member. It copies the neighbouring member's indentation, or opens the
 * object onto its own lines when it was empty.
 */
export function insertMember(text, obj, key, raw, after = null) {
  const k = JSON.stringify(key);
  const ref = after || obj.members[obj.members.length - 1];
  if (!ref) {
    const outer = indentAt(text, obj.start);
    return splice(text, obj.start, obj.end, `{\n${outer}  ${k}: ${raw}\n${outer}}`);
  }
  const pad = indentAt(text, ref.keyStart);
  const sameLine = !text.slice(obj.start, obj.end).includes('\n');
  const sep = sameLine ? ' ' : `\n${pad}`;
  return splice(text, ref.value.end, ref.value.end, `,${sep}${k}: ${raw}`);
}

/** Remove a member and exactly one of the commas beside it. */
export function removeMember(text, obj, m) {
  const idx = obj.members.indexOf(m);
  if (obj.members.length === 1) {
    // Keep the object's own braces and whatever sits outside them.
    return splice(text, obj.start + 1, obj.end - 1, '');
  }
  if (idx < obj.members.length - 1) {
    return splice(text, m.keyStart, obj.members[idx + 1].keyStart, '');
  }
  return splice(text, obj.members[idx - 1].value.end, m.value.end, '');
}
