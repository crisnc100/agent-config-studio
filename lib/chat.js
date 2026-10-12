import fs from 'node:fs';
import { getHarness, modelsFor, runContained } from './harness.js';
import { INIT_DEADLINE_MS } from './containment.js';
import { readUserText, resolveSafe, tilde } from './paths.js';

/**
 * Multi-turn assist. The user names the files; this never searches for targets
 * or edits anything that was not explicitly mentioned.
 *
 * Edits come back as anchored search/replace blocks rather than whole-file
 * rewrites, so the response stays proportional to the change instead of the
 * file — a one-line rule change is a few lines out, not a full re-emission.
 */

/**
 * Claude's model allowlist, read from the registry on every call — never a
 * module-load snapshot, so a registry edit reaches a running server.
 * Unknown ids fall back to the harness default rather than reaching argv.
 */
export const modelList = () =>
  Object.entries(modelsFor(getHarness('claude')).models).map(([id, m]) => ({ id, label: m.label }));

const EDIT_FORMAT = `
When the user asks for a change, reply with a short sentence of explanation and
then one or more edit blocks in EXACTLY this format:

@@EDIT <file path exactly as given to you>
@@SEARCH
<text to find — copy it verbatim from the file, including indentation>
@@REPLACE
<text to put in its place>
@@END

To add something new at the end of a file, use:

@@APPEND <file path exactly as given to you>
<text to append>
@@END

Rules for edit blocks:
- The SEARCH text must appear EXACTLY ONCE in the file. Include enough
  surrounding context to make it unique.
- Do not reformat, re-indent, or "improve" anything the user did not ask about.
- Change the smallest span that accomplishes the request.
- One block per distinct change. Several blocks in one reply is fine.
- If the user only asked a question, answer it and emit no edit blocks.
`.trim();

const STYLE = `
You are helping edit AI agent configuration files (CLAUDE.md, AGENTS.md,
SKILL.md, settings, hooks) on a developer's machine.

House style for these files:
- Imperative and specific. "Route X to Y", never "you might consider routing X to Y".
- Every rule states its trigger and its action.
- Keep concrete details exact: paths, commands, model ids, thresholds.
- No filler, no preamble, no restating the obvious.

Be concise. Lead with the most important point. Unless the user asks for an
exhaustive pass, give at most three points. Never pad.
`.trim();

/** Build the text sent to the CLI for one turn. */
export function buildTurn({ message, mentions, isFirst, seed }) {
  const parts = [];
  if (isFirst) parts.push(STYLE, '', EDIT_FORMAT, '');
  if (isFirst && seed) {
    parts.push(
      'SUMMARY OF THE EARLIER PART OF THIS CONVERSATION (it was compacted to free context):',
      seed, '');
  }

  if (mentions.length) {
    parts.push('FILES THE USER HAS POINTED AT (current contents, authoritative):');
    for (const abs of mentions) {
      let content = '';
      try { content = readUserText(abs); } catch (e) { content = `<unreadable: ${e.message}>`; }
      parts.push(`\n@@FILE ${tilde(abs)}\n${content}\n@@ENDFILE`);
    }
    parts.push('', 'Only edit the files listed above. Never propose edits to anything else.');
  } else {
    parts.push('The user has not pointed at any file, so do not propose edits — answer the question.');
  }

  parts.push('', 'USER:', message);
  return parts.join('\n');
}

/**
 * Parse edit blocks out of a reply and resolve each against the file on disk.
 * A block that does not anchor uniquely is reported, never guessed at.
 */
export function parseEdits(reply, allowedPaths) {
  const allowed = new Map(allowedPaths.map((p) => [tilde(p), p]));
  const blocks = [];
  const out = [];

  const re = /^@@(EDIT|APPEND)[ \t]+(.+?)[ \t]*$/gm;
  let m;
  while ((m = re.exec(reply))) {
    const kind = m[1];
    const label = m[2].trim();
    const endIdx = reply.indexOf('\n@@END', re.lastIndex);
    if (endIdx === -1) continue;
    const body = reply.slice(re.lastIndex, endIdx).replace(/^\n/, '');

    const abs = allowed.get(label);
    if (!abs) {
      out.push({ display: label, error: 'Model referenced a file you did not point at — ignored.' });
      continue;
    }
    if (kind === 'APPEND') {
      blocks.push({ abs, label, kind, append: body.replace(/\n+$/, '') });
      continue;
    }
    const sep = body.indexOf('\n@@REPLACE\n');
    if (!body.startsWith('@@SEARCH\n') || sep === -1) {
      out.push({ display: label, path: abs, error: 'Malformed edit block — skipped.' });
      continue;
    }
    blocks.push({
      abs, label, kind,
      search: body.slice('@@SEARCH\n'.length, sep),
      replace: body.slice(sep + '\n@@REPLACE\n'.length),
    });
  }

  // Every SEARCH is written against the file as the model was shown it, so all
  // blocks for a file resolve against that ORIGINAL content and are spliced in
  // one pass. Applying them in sequence would let one edit invalidate or
  // double-apply the next.
  const byFile = new Map();
  for (const b of blocks) {
    if (!byFile.has(b.abs)) byFile.set(b.abs, []);
    byFile.get(b.abs).push(b);
  }

  for (const [abs, list] of byFile) {
    let original;
    try { original = readUserText(abs); }
    catch (e) { out.push({ display: tilde(abs), path: abs, error: e.message }); continue; }

    const spans = [];
    let failed = null;
    let appended = '';

    for (const b of list) {
      if (b.kind === 'APPEND') { appended += (appended ? '\n' : '') + b.append; continue; }
      const hits = countOccurrences(original, b.search);
      if (hits === 0) {
        failed = 'The text it tried to change was not found in the file — nothing applied.';
        break;
      }
      if (hits > 1) {
        failed = `The text it tried to change appears ${hits} times — too ambiguous to edit safely.`;
        break;
      }
      const start = original.indexOf(b.search);
      spans.push({ start, end: start + b.search.length, replace: b.replace });
    }
    if (failed) { out.push({ display: tilde(abs), path: abs, error: failed }); continue; }

    spans.sort((a, b) => a.start - b.start);
    for (let i = 1; i < spans.length; i++) {
      if (spans[i].start < spans[i - 1].end) {
        failed = 'It proposed two overlapping changes to the same text — ask it to redo this one.';
        break;
      }
    }
    if (failed) { out.push({ display: tilde(abs), path: abs, error: failed }); continue; }

    let proposed = '';
    let cursor = 0;
    for (const s of spans) {
      proposed += original.slice(cursor, s.start) + s.replace;
      cursor = s.end;
    }
    proposed += original.slice(cursor);

    if (appended) {
      proposed += (proposed.endsWith('\n') ? '' : '\n') + appended + '\n';
    }
    if (proposed === original) continue;   // nothing actually changed

    out.push({
      path: abs, display: tilde(abs),
      kind: spans.length ? 'edit' : 'append',
      current: original, proposed,
      edits: spans.length + (appended ? 1 : 0),
    });
  }
  return out;
}

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

/**
 * Stream one turn. Calls onDelta with incremental text, resolves with the full
 * reply and the session id to resume from. Returns a kill handle so a cancelled
 * request tears the child down instead of orphaning it.
 *
 * The spawn and its containment checks are runContained's (lib/harness.js).
 */
export function streamTurn({
  message, mentions, sessionId, seed,
  model, cwd, harness = 'claude', initDeadlineMs = INIT_DEADLINE_MS,
}, onDelta) {
  const prompt = buildTurn({ message, mentions, isFirst: !sessionId, seed });
  const desc = getHarness(harness);
  const det = desc.detect();
  if (!det.installed || !det.binary) {
    throw Object.assign(new Error(`${desc.label} is not installed`), { status: 400 });
  }
  const { models, defaultModel } = modelsFor(desc);
  const id = Object.hasOwn(models, model) ? model : defaultModel;
  if (!id) throw Object.assign(new Error(`${desc.label} has no usable model in the registry`), { status: 500 });
  const effort = models[id].effort;
  return runContained({
    descriptor: desc, binary: det.binary, opts: { model: id, sessionId, effort }, prompt, cwd, initDeadlineMs,
  }, onDelta);
}

export const resolveMentions = (list) =>
  (Array.isArray(list) ? list : []).map((p) => resolveSafe(p));
