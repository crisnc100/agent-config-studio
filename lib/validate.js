/**
 * Pre-save validation. Everything here is editable, which means a bad save can
 * break harness startup — so a save is refused outright on `error`, and merely
 * annotated on `warn`.
 *
 * Guiding rule: a false rejection is worse than a missed problem. Only raise an
 * error for something that is definitely broken; when a construct is merely
 * unrecognised, stay quiet rather than block a legitimate save.
 */

export function validate(filePath, content, kind) {
  const errors = [];
  const warnings = [];

  if (content.length === 0) warnings.push('File is empty.');

  if (kind === 'json') {
    try {
      JSON.parse(content);
    } catch (e) {
      errors.push(`Invalid JSON: ${e.message}`);
    }
  }

  if (kind === 'toml') {
    const r = scanToml(content);
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  }

  if (kind === 'shell') {
    if (!content.startsWith('#!')) warnings.push('No shebang on line 1 — the harness may not execute this.');
  }

  if (/SKILL\.md$/.test(filePath)) {
    checkSkillFrontmatter(content, errors, warnings);
  }

  if (/CLAUDE\.md$|AGENTS\.md$/.test(filePath) && content.trim().length > 0) {
    const lines = content.split('\n').length;
    if (lines > 400) warnings.push(`${lines} lines — long memory files dilute attention. Consider splitting.`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/* ── SKILL.md frontmatter ─────────────────────────────────────────────── */

function checkSkillFrontmatter(content, errors, warnings) {
  const lines = content.split('\n');
  if (lines[0].trim() !== '---') {
    errors.push('SKILL.md must open with a line containing exactly `---`.');
    return;
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { close = i; break; }
  }
  if (close === -1) {
    errors.push('Frontmatter block is never closed with a line containing exactly `---`.');
    return;
  }

  // Collect key -> value, folding YAML continuation lines into the previous key.
  const fields = new Map();
  let lastKey = null;
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (m) {
      lastKey = m[1];
      fields.set(lastKey, m[2].trim());
    } else if (lastKey) {
      fields.set(lastKey, `${fields.get(lastKey)} ${line.trim()}`.trim());
    }
  }

  for (const key of ['name', 'description']) {
    if (!fields.has(key)) {
      errors.push(`Frontmatter is missing required key \`${key}\`.`);
    } else if (!stripQuotes(fields.get(key))) {
      errors.push(`Frontmatter key \`${key}\` has no value.`);
    }
  }

  const desc = stripQuotes(fields.get('description') ?? '');
  if (desc && desc.length < 40) {
    warnings.push('Description is short — it is the only thing the model sees when deciding to load this skill.');
  }
  if (desc.length > 1024) {
    warnings.push(`Description is ${desc.length} chars; very long descriptions crowd the skill index.`);
  }
}

function stripQuotes(v) {
  const t = (v ?? '').trim();
  if ((t.startsWith('"') && t.endsWith('"') && t.length > 1) ||
      (t.startsWith("'") && t.endsWith("'") && t.length > 1)) {
    return t.slice(1, -1).trim();
  }
  return t;
}

/* ── TOML ─────────────────────────────────────────────────────────────── */

/**
 * Character scanner that understands the TOML constructs which trip up a
 * line-by-line check: comments, basic/literal strings, multi-line strings, and
 * values (arrays, inline tables) that legally span several physical lines.
 *
 * It collapses the document into logical statements and checks only their
 * shape. Strings are replaced by a placeholder so a `#` or `=` inside one is
 * never mistaken for syntax.
 */
export function scanToml(src) {
  const errors = [];
  const warnings = [];

  const statements = [];
  let buf = '';
  let bufLine = 1;
  let depth = 0;      // nesting of [ ] and { }
  let line = 1;
  let i = 0;

  const flush = () => {
    if (buf.trim()) statements.push({ text: buf.trim(), line: bufLine });
    buf = '';
  };

  while (i < src.length) {
    // Multi-line strings must be tested before single-character quotes.
    if (src.startsWith('"""', i) || src.startsWith("'''", i)) {
      const delim = src.slice(i, i + 3);
      const end = src.indexOf(delim, i + 3);
      if (end === -1) {
        errors.push(`Line ${line}: unterminated multi-line string (${delim}).`);
        return { errors, warnings };
      }
      const consumed = src.slice(i, end + 3);
      line += countNewlines(consumed);
      buf += ' «str» ';
      i = end + 3;
      continue;
    }

    const c = src[i];

    if (c === '"' || c === "'") {
      const basic = c === '"';
      let j = i + 1;
      let closed = false;
      while (j < src.length) {
        if (src[j] === '\n') break;                     // strings cannot span lines
        if (basic && src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { closed = true; break; }
        j++;
      }
      if (!closed) {
        errors.push(`Line ${line}: unterminated string.`);
        return { errors, warnings };
      }
      buf += ' «str» ';
      i = j + 1;
      continue;
    }

    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }

    if (c === '[' || c === '{') { depth++; buf += c; i++; continue; }

    if (c === ']' || c === '}') {
      depth--;
      if (depth < 0) {
        errors.push(`Line ${line}: unmatched \`${c}\`.`);
        return { errors, warnings };
      }
      buf += c;
      i++;
      continue;
    }

    if (c === '\n') {
      line++;
      // A newline only ends a statement at the top level; inside an array or
      // inline table it is just whitespace.
      if (depth === 0) { flush(); bufLine = line; }
      else buf += ' ';
      i++;
      continue;
    }

    if (!buf.trim() && (c === ' ' || c === '\t')) { bufLine = line; i++; continue; }

    buf += c;
    i++;
  }
  flush();

  if (depth > 0) errors.push('Unclosed `[` or `{` — the file ends inside a value.');

  for (const { text, line: ln } of statements) {
    // Table header or array-of-tables header.
    if (/^\[\[[^\]]*\]\]$/.test(text) || /^\[[^\[\]]*\]$/.test(text)) {
      if (!text.replace(/[[\]]/g, '').trim()) errors.push(`Line ${ln}: empty table header.`);
      continue;
    }
    const eq = text.indexOf('=');
    if (eq === -1) {
      errors.push(`Line ${ln}: not a key/value pair or table header — "${clip(text)}"`);
      continue;
    }
    if (!text.slice(0, eq).trim()) errors.push(`Line ${ln}: missing key before "=".`);
    if (!text.slice(eq + 1).trim()) errors.push(`Line ${ln}: missing value after "=".`);
  }

  return { errors, warnings };
}

const countNewlines = (s) => (s.match(/\n/g) || []).length;
const clip = (s) => (s.length > 70 ? s.slice(0, 70) + '…' : s);
