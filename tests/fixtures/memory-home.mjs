/**
 * A fake HOME for the Memory and Context views: every slug state, a two-hop
 * git worktree, both frontmatter formats, index rot of every kind, and a
 * transcript corpus whose only real evidence is two successful writes.
 *
 * Shared by tests/memory.mjs, tests/context-map.mjs and
 * tests/memory-qa-server.mjs, so the QA server shows exactly what the suite
 * asserts. Everything is written under `home`; nothing here reads the real one.
 */
import fs from 'node:fs';
import path from 'node:path';

export const MARK = {
  transcript: 'MARKER-TRANSCRIPT-TEXT-5e0c',
  credential: 'MARKER-CREDENTIAL-2b71',
};

// Timestamps the lastWrite evidence carries. OK < SUB, and the errored and
// unanswered attempts are NEWER than both, so counting either would show.
export const TS = {
  ok: '2026-05-01T10:00:00.000Z',
  sub: '2026-06-01T10:00:00.000Z',
  err: '2026-08-01T10:00:00.000Z',
  noResult: '2026-08-15T10:00:00.000Z',
};

export const enc = (abs) => abs.replace(/[^A-Za-z0-9]/g, '-');

const fm = {
  nested: (name, desc, type, extra = '') =>
    `---\nname: ${name}\ndescription: "${desc}"\nmetadata:\n  node_type: memory\n  type: ${type}\n${extra}  originSessionId: 00000000-0000-0000-0000-000000000001\n---\n\n`,
  flat: (name, desc, type) => `---\nname: ${name}\ndescription: ${desc}\ntype: ${type}\noriginSessionId: 00000000-0000-0000-0000-000000000002\n---\n\n`,
};

/** The 13-link index line from the real kylie-main MEMORY.md, reshaped: 8 live, 5 dangling. */
export const RUN_LINKS = [
  ['dev:all', 'live-1.md'], ['biome only', 'live-2.md'], ['fresh branches', 'gone-1.md'],
  ['no preview', 'gone-2.md'], ['root cause', 'live-3.md'], ['no worktree', 'gone-3.md'],
  ['no auto-split', 'live-4.md'], ['review phases', 'live-5.md'], ['skip migrate', 'live-6.md'],
  ['branch off main', 'live-7.md'], ['always /pr', 'gone-4.md'], ['follow /pr', 'live-8.md'],
  ['real emails', 'gone-5.md'],
];
export const RUN_LINE = '- ' + RUN_LINKS.map(([t, f]) => `[${t}](${f})`).join(' · ');

export function alphaIndex() {
  return [
    '# Alpha memory',
    '',
    'Prose that must survive every edit byte for byte.',
    '',
    '- [Fact A](fact-a.md) — the nested-format fact',
    '- [Fact B](fact-b.md) — the flat-format fact',
    '- [Fact C](fact-c.md) — no frontmatter at all',
    '- [Future](future.md) — dated in the future',
    '- [Gone entry](gone-entry.md) — a whole entry whose file is missing',
    '- [Moved](moved.md) — now lives in _archive',
    RUN_LINE,
    '',
    'See also [the notes](live-1.md) for more.',
    '',
  ].join('\n');
}

const put = (file, body, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, mode ? { mode } : undefined);
};
const jsonl = (recs, partialTail = '') => recs.map((r) => JSON.stringify(r)).join('\n') + '\n' + partialTail;

const assistant = (id, name, filePath, ts) => ({
  type: 'assistant', timestamp: ts,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: { file_path: filePath, old_string: 'x', new_string: 'y' } }] },
});
const result = (id, ok, ts) => ({
  type: 'user', timestamp: ts,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: ok ? 'The file has been updated.' : `<tool_use_error>${MARK.transcript}</tool_use_error>`, ...(ok ? {} : { is_error: true }) }] },
});

/**
 * Build the fixture. Returns the paths the suites assert against.
 */
export function seedMemoryHome(home) {
  const H = (...p) => path.join(home, ...p);
  const P = (...p) => H('Documents', 'Projects', ...p);
  const slugDir = (abs) => H('.claude', 'projects', enc(abs));

  // ── checkouts ─────────────────────────────────────────────────────────
  // alpha: a main checkout with a real .git directory, and a worktree whose
  // `.git` FILE names a RELATIVE gitdir, whose `commondir` says `../..`.
  const alpha = P('alpha');
  fs.mkdirSync(path.join(alpha, '.git', 'objects'), { recursive: true });
  put(path.join(alpha, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const wt = P('alpha-wt', 'alpha-feature');
  const wtMeta = path.join(alpha, '.git', 'worktrees', 'alpha-feature');
  put(path.join(wtMeta, 'commondir'), '../..\n');
  put(path.join(wtMeta, 'HEAD'), 'ref: refs/heads/feature\n');
  put(path.join(wt, '.git'), `gitdir: ${path.relative(wt, wtMeta)}\n`);
  // A second worktree living INSIDE the project, under .worktrees/.
  const inner = path.join(alpha, '.worktrees', 'inner');
  const innerMeta = path.join(alpha, '.git', 'worktrees', 'inner');
  put(path.join(innerMeta, 'commondir'), '../..\n');
  put(path.join(inner, '.git'), `gitdir: ${innerMeta}\n`);
  // A project directory BELOW the checkout root.
  const web = path.join(alpha, 'apps', 'web');
  fs.mkdirSync(web, { recursive: true });

  const notes = P('notes');                      // not a repository
  fs.mkdirSync(notes, { recursive: true });
  fs.mkdirSync(P('my-app'), { recursive: true }); // my-app and my_app: one slug, two paths
  fs.mkdirSync(P('my_app'), { recursive: true });
  const locked = P('locked');                     // listed as inaccessible
  fs.mkdirSync(path.join(locked, 'inner'), { recursive: true });

  // ── context files ─────────────────────────────────────────────────────
  const trunkClaude = '# Alpha\n\n## Build\n\nnpm test\n\n## Style\n\n- tabs\n- short functions\n';
  put(path.join(alpha, 'CLAUDE.md'), trunkClaude);
  fs.symlinkSync('CLAUDE.md', path.join(alpha, 'AGENTS.md'));
  put(path.join(alpha, 'docs', 'CLAUDE.md'), trunkClaude);          // same bytes, different scope
  fs.symlinkSync('../CLAUDE.md', path.join(alpha, 'docs', 'AGENTS.md')); // a link at ANOTHER scope: its own entry
  put(path.join(web, 'CLAUDE.md'), '# Web\n\n## Run\n\nnpm run dev\n');
  put(path.join(alpha, '.cursor', 'rules', 'style.mdc'), '---\ndescription: style\n---\n\n# Style rule\n\nUse tabs.\n');
  put(path.join(alpha, 'node_modules', 'pkg', 'CLAUDE.md'), '# vendored — must never be listed\n');
  put(path.join(wt, 'CLAUDE.md'), trunkClaude);                      // identical worktree copy
  put(path.join(wt, 'apps', 'web', 'CLAUDE.md'), '# Web\n\n## Run\n\nnpm run dev -- --port 4000\n\n## Drift\n\nonly here\n');
  put(path.join(inner, 'CLAUDE.md'), trunkClaude);
  put(path.join(notes, 'CLAUDE.md'), '# Notes\n\nNot a repository.\n');

  // ── the secret a planted link would be after ──────────────────────────
  put(H('.claude', '.credentials.json'), `{"token":"${MARK.credential}"}\n`);

  // ── memory: alpha (the main checkout's slug) ──────────────────────────
  const alphaSlug = slugDir(alpha);
  const mem = path.join(alphaSlug, 'memory');
  put(path.join(mem, 'MEMORY.md'), alphaIndex());
  put(path.join(mem, 'fact-a.md'), fm.nested('fact-a', 'Nested format fact', 'project', '  modified: 2026-03-01T00:00:00.000Z\n') + 'Body of fact A.\n');
  put(path.join(mem, 'fact-b.md'), fm.flat('fact-b', 'Flat format fact', 'feedback') + 'Body of fact B.\n');
  put(path.join(mem, 'fact-c.md'), 'No frontmatter here, just text.\n');
  put(path.join(mem, 'future.md'), fm.nested('future-fact', 'From the future', 'project', '  modified: 2999-01-01T00:00:00.000Z\n') + 'Time traveller.\n');
  put(path.join(mem, 'unindexed.md'), fm.nested('unindexed-fact', 'Nobody linked me', 'reference') + 'Lonely.\n');
  put(path.join(mem, '_archive', 'moved.md'), fm.flat('moved', 'Archived fact', 'project') + 'Old.\n');
  put(path.join(mem, '_archive', 'never-linked.md'), fm.flat('never-linked', 'Archived and unlinked', 'project') + 'Older.\n');
  for (const [, f] of RUN_LINKS) if (f.startsWith('live-')) put(path.join(mem, f), fm.flat(f.slice(0, -3), `Run fact ${f}`, 'feedback') + 'x\n');
  // Refused, never rows: a link to the credential, and a denied name.
  fs.symlinkSync(H('.claude', '.credentials.json'), path.join(mem, 'sneaky.md'));
  put(path.join(mem, 'auth.json', 'notes.md'), `${MARK.credential}\n`);

  // Transcripts under the WORKTREE slug: 50 mentions, one successful Edit,
  // one errored Edit, one Edit that never got a result, and a torn last line.
  const factA = path.join(mem, 'fact-a.md');
  const recs = [];
  for (let i = 0; i < 50; i++) {
    recs.push({ type: 'user', timestamp: '2026-09-01T00:00:00.000Z', message: { role: 'user', content: `${MARK.transcript} see fact-a.md and ${factA} (${i})` } });
  }
  recs.push(assistant('toolu_ok', 'Edit', factA, TS.ok), result('toolu_ok', true, TS.ok));
  recs.push(assistant('toolu_err', 'Edit', factA, TS.err), result('toolu_err', false, TS.err));
  recs.push(assistant('toolu_nores', 'Edit', factA, TS.noResult));
  put(path.join(slugDir(wt), 'session-1.jsonl'), jsonl(recs, '{"type":"assistant","message":{"content":[{"type":"tool_u'));
  // ...and a subagent transcript under the main slug, one successful Write.
  put(path.join(alphaSlug, 'session-2', 'subagents', 'agent-x.jsonl'),
    jsonl([{ ...assistant('toolu_sub', 'Write', factA, TS.sub) }, result('toolu_sub', true, TS.sub)]));
  // The project-subdir slug: no memory, just a session.
  put(path.join(slugDir(web), 'session-3.jsonl'), jsonl([{ type: 'user', message: { content: MARK.transcript } }]));

  // ── memory: notes (non-git, no index) ─────────────────────────────────
  put(path.join(slugDir(notes), 'memory', 'jot.md'), fm.nested('jot', 'A note with no index', 'user') + 'Jot.\n');

  // ── memory: ambiguous, inaccessible, missing (orphan with a counterpart) ─
  put(path.join(H('.claude', 'projects', enc(P('my-app'))), 'memory', 'which.md'), fm.flat('which', 'Which app?', 'project') + 'Either.\n');
  put(path.join(H('.claude', 'projects', enc(path.join(locked, 'inner'))), 'memory', 'locked.md'), fm.flat('locked', 'Behind a locked dir', 'project') + 'Locked.\n');
  const oldAlpha = H('.claude', 'projects', enc(H('Documents', 'Old', 'alpha')));
  put(path.join(oldAlpha, 'memory', 'MEMORY.md'), '- [Fact A](fact-a.md) — the relocated copy\n');
  put(path.join(oldAlpha, 'memory', 'fact-a.md'), fm.nested('fact-a', 'Nested format fact (old copy)', 'project') + 'Body of fact A, older.\n');
  put(path.join(oldAlpha, 'memory', 'only-old.md'), fm.flat('only-old', 'Only in the old dir', 'project') + 'Old only.\n');
  put(path.join(oldAlpha, 'transcript.jsonl'), jsonl([{ type: 'user', message: { content: 'old' } }]));

  // ── slugs that exist only to be (in)eligible for the empty-folder trash ─
  const emptyA = H('.claude', 'projects', enc(P('empty-one')));
  const emptyB = H('.claude', 'projects', enc(P('empty-two')));
  fs.mkdirSync(path.join(emptyA, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(emptyB, 'memory'), { recursive: true });
  const withTranscript = H('.claude', 'projects', enc(P('has-transcript')));
  fs.mkdirSync(path.join(withTranscript, 'memory'), { recursive: true });
  put(path.join(withTranscript, 's.jsonl'), jsonl([{ type: 'user', message: { content: 'hi' } }]));
  // Temp probes: hidden from the project list; the one holding only an
  // empty memory/ is still eligible, the one with a transcript is not.
  const probeEmpty = H('.claude', 'projects', '-private-var-folders-xx-T-acs-claude-writeprobe-AbC123');
  fs.mkdirSync(path.join(probeEmpty, 'memory'), { recursive: true });
  const probeBusy = H('.claude', 'projects', '-private-tmp-claude-501-scratch-Zz9');
  fs.mkdirSync(path.join(probeBusy, 'memory'), { recursive: true });
  put(path.join(probeBusy, 'p.jsonl'), jsonl([{ type: 'user', message: { content: 'probe' } }]));
  // A populated probe: its memory is real, but a scratch session is not a project.
  put(path.join(probeBusy, 'memory', 'probe-fact.md'), fm.flat('probe-fact', 'Written by a scratch session', 'project') + 'Scratch.\n');
  // A symlinked memory dir and a symlinked slug: refused, never listed.
  const linkedMem = H('.claude', 'projects', enc(P('linked-mem')));
  fs.mkdirSync(linkedMem, { recursive: true });
  fs.symlinkSync(mem, path.join(linkedMem, 'memory'));
  fs.symlinkSync(alphaSlug, H('.claude', 'projects', enc(P('linked-slug'))));

  // Last: after this nothing can be created under it.
  fs.chmodSync(locked, 0o000);

  return {
    alpha, wt, inner, web, notes, locked, mem, alphaSlug, factA, oldAlpha,
    emptyA, emptyB, withTranscript, probeEmpty, probeBusy, linkedMem,
    slugs: {
      alpha: enc(alpha), wt: enc(wt), web: enc(web), notes: enc(notes),
      ambiguous: enc(P('my-app')), inaccessible: enc(path.join(locked, 'inner')),
      missing: enc(H('Documents', 'Old', 'alpha')),
    },
  };
}

/** Undo the one thing rm -rf cannot get past. */
export function unlockMemoryHome(home) {
  try { fs.chmodSync(path.join(home, 'Documents', 'Projects', 'locked'), 0o755); } catch {}
}
