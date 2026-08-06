/**
 * Pre-save validation. Everything here is editable, which means a bad save can
 * break harness startup — so a save is refused outright on `error`, and merely
 * annotated on `warn`.
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
    checkToml(content, errors, warnings);
  }

  if (kind === 'shell') {
    if (!content.startsWith('#!')) warnings.push('No shebang on line 1 — the harness may not execute this.');
    const q = countUnbalanced(content);
    if (q) warnings.push(`Possibly unbalanced ${q} in the script.`);
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

function checkSkillFrontmatter(content, errors, warnings) {
  if (!content.startsWith('---')) {
    errors.push('SKILL.md must open with a YAML frontmatter block (`---`).');
    return;
  }
  const end = content.indexOf('\n---', 3);
  if (end === -1) {
    errors.push('Frontmatter block is never closed with `---`.');
    return;
  }
  const block = content.slice(3, end);
  const keys = new Set();
  for (const line of block.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):/);
    if (m) keys.add(m[1]);
  }
  if (!keys.has('name')) errors.push('Frontmatter is missing required key `name`.');
  if (!keys.has('description')) errors.push('Frontmatter is missing required key `description`.');

  const desc = block.match(/description:\s*([\s\S]*?)(?:\n[a-z-]+:|$)/i)?.[1]?.trim() ?? '';
  if (desc && desc.length < 40) {
    warnings.push('Description is short — it is the only thing the model sees when deciding to load this skill.');
  }
  if (desc.length > 1024) {
    warnings.push(`Description is ${desc.length} chars; very long descriptions crowd the skill index.`);
  }
}

/** Structural sanity only — not a full TOML parse. */
function checkToml(content, errors, warnings) {
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    if (t.startsWith('[')) {
      if (!/\]$/.test(t)) errors.push(`Line ${i + 1}: table header is not closed — "${t}"`);
      return;
    }
    if (!t.includes('=')) {
      errors.push(`Line ${i + 1}: not a key/value pair or table header — "${t}"`);
    }
  });
  const dq = (content.match(/"/g) || []).length;
  if (dq % 2 !== 0) warnings.push('Odd number of double quotes — check for an unterminated string.');
}

function countUnbalanced(s) {
  const stripped = s.replace(/#.*$/gm, '');
  const single = (stripped.match(/'/g) || []).length;
  const dbl = (stripped.match(/"/g) || []).length;
  if (single % 2 !== 0) return 'single quotes';
  if (dbl % 2 !== 0) return 'double quotes';
  return null;
}
