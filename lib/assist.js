import path from 'node:path';
import { getHarness, spawnContained } from './harness.js';

/** Writing assist. Shells out to a contained local harness CLI. */

const HOUSE_STYLE = `
House style for agent instruction files:
- Imperative and specific. "Route X to Y", never "you might consider routing X to Y".
- Every rule states the trigger and the action. A rule with no trigger never fires.
- No filler headers, no restating the obvious, no motivational preamble.
- Tables for anything with 3+ parallel cases. Prose for judgment calls.
- Keep concrete details: paths, command syntax, model ids, thresholds. Those are the value.
- Shorter is better ONLY when nothing load-bearing is lost.
`.trim();

const SKILL_RULES = `
This file is a SKILL.md. Hard requirements:
- Opens with YAML frontmatter delimited by --- containing at minimum \`name\` and \`description\`.
- \`description\` is the ONLY text the model sees when deciding whether to load the skill.
  It must state both what the skill does AND when to use it, including trigger phrases.
- Body is the instructions the model follows once loaded. Do not duplicate the description there.
`.trim();

const ACTIONS = {
  tighten: {
    label: 'Tighten',
    instruction: 'Tighten this file. Cut filler, redundancy, and hedging. Preserve every load-bearing rule, path, command, and threshold exactly. Do not add new rules. Do not reorganize unless it clearly helps.',
  },
  critique: {
    label: 'Critique',
    instruction: 'Do NOT rewrite. Review this file and report: (1) rules that are ambiguous or have no clear trigger, (2) contradictions, (3) anything stale or redundant, (4) what is missing. Be specific and cite the text. Return prose findings, not a rewritten file.',
    readOnly: true,
  },
  format: {
    label: 'Reformat',
    instruction: 'Reformat this file for clarity and scannability: consistent heading levels, tables where there are parallel cases, tight lists. Change presentation only — do not alter the meaning of any rule, and do not add or remove content.',
  },
  frontmatter: {
    label: 'Improve description',
    instruction: 'Improve ONLY the `description` field in the YAML frontmatter so the model reliably loads this skill at the right moment: state what it does, when to use it, and the natural trigger phrases a user would say. Leave the body and all other frontmatter keys byte-identical. Return the complete file.',
  },
};

export function listActions() {
  return Object.entries(ACTIONS).map(([id, a]) => ({ id, label: a.label, readOnly: !!a.readOnly }));
}

/**
 * Single source of truth for what a request is and whether it returns prose or
 * a file. Both the prompt and the response must agree — if they disagree, the
 * UI offers to write critique prose into the user's config file.
 */
export function resolveMode({ action, instruction }) {
  const spec = ACTIONS[action];
  if (spec) return { task: spec.instruction, readOnly: !!spec.readOnly };
  const text = instruction || 'Improve this file.';
  return {
    task: text,
    readOnly: /^(review|critique|check|what|why|explain|how|does|is|are)\b/i.test(text.trim()),
  };
}

export function buildPrompt({ action, instruction, filePath, content }) {
  const { task, readOnly } = resolveMode({ action, instruction });
  const isSkill = /SKILL\.md$/.test(filePath);

  return [
    `You are editing an AI agent configuration file on a developer's machine.`,
    `File: ${filePath}`,
    ``,
    HOUSE_STYLE,
    isSkill ? `\n${SKILL_RULES}` : '',
    ``,
    `TASK: ${task}`,
    ``,
    readOnly
      ? `Return your findings as plain markdown prose. Do not return a rewritten file.`
      : `Return ONLY the complete new file contents. No preamble, no explanation, no markdown code fence around the whole file. The output is written directly to disk.`,
    ``,
    `--- BEGIN CURRENT FILE ---`,
    content,
    `--- END CURRENT FILE ---`,
  ].filter(Boolean).join('\n');
}

/**
 * Strip a wrapping code fence if the model added one despite instructions.
 * Only trims when a fence was actually removed — otherwise the result is
 * returned byte-for-byte, so trailing newlines survive.
 */
function unfence(text) {
  const m = text.trim().match(/^```[a-zA-Z]*\n([\s\S]*)\n```$/);
  return m ? m[1] : text;
}

export function runAssist({
  action, instruction, filePath, content,
  model = 'claude-sonnet-5', harness = 'claude',
}) {
  const prompt = buildPrompt({ action, instruction, filePath, content });
  const { readOnly } = resolveMode({ action, instruction });
  const desc = getHarness(harness);
  const det = desc.detect();
  if (!det.installed || !det.binary) {
    return Promise.reject(Object.assign(new Error(`${desc.label} is not installed`), { status: 400 }));
  }
  const id = Object.hasOwn(desc.models, model) ? model : desc.defaultModel;
  const effort = desc.models[id].effort;

  const { child } = spawnContained({
    descriptor: desc,
    binary: det.binary,
    opts: { model: id, effort, outputFormat: 'json' },
    prompt,
    cwd: path.dirname(filePath),
  });

  const done = new Promise((resolve, reject) => {
    let out = '', err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error('assist timed out after 180s'), { status: 504 }));
    }, 180_000);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(Object.assign(
          new Error(`${desc.id} CLI exited ${code}: ${err.slice(0, 500) || 'no stderr'}`),
          { status: 502 }
        ));
      }
      let result;
      try {
        const env = JSON.parse(out);
        result = env.result ?? env.text ?? '';
      } catch {
        result = out;
      }
      if (!result.trim()) {
        return reject(Object.assign(new Error('assist returned nothing'), { status: 502 }));
      }
      resolve({ readOnly, result: readOnly ? result.trim() : unfence(result) });
    });
  });

  return done;
}
