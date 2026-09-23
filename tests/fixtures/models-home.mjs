/**
 * A temp HOME seeded with the three CLI catalogs, in the real files' shapes,
 * for the Models panel tests and the QA launcher. Never the live HOME.
 *
 * Every field the panel must never pass on carries a MARKER, and so does the
 * Claude catalog's filename: a response body containing "MARKER" is a leak.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MARKERS = {
  identity: 'MARKER-IDENTITY-5e1f',
  auth: 'MARKER-AUTH-METHOD-77c2',
  origin: 'MARKER-ORIGIN-a0d9',
  etag: 'MARKER-ETAG-19be',
  messages: 'MARKER-MODEL-MESSAGES-4c4c',
  apiKey: 'MARKER-API-KEY-e3e3',
  filename: 'MARKER-FILENAME-0b7d',
};

const HOUR = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();

export const claudeModel = (id, name, short, min = null) => ({
  id, name, short_name: short, description: `${name} model`, section: 'models', notice: null,
  capabilities: {}, thinking: {}, quick_select: false, min_claude_code_version: min,
});

export const codexModel = (slug, display, visibility = 'list', upgrade = null) => ({
  slug, display_name: display, description: `${display} model`, default_reasoning_level: 'medium',
  supported_reasoning_levels: [], shell_type: 'default', visibility, supported_in_api: true, priority: 1,
  ...(upgrade ? { upgrade } : {}),
  model_messages: { persistent_instructions: `${MARKERS.messages} system prompt for ${slug}` },
  context_window: 272000,
});

export const grokModel = (id, name, hidden = false) => ({
  info: { id, model: id, model_family: 'xai', name, description: `${name} model`, hidden, supported_in_api: true },
  api_key: MARKERS.apiKey, env_key: `${MARKERS.apiKey}-ENV`, api_base_url: `https://${MARKERS.origin}.invalid`,
});

/** What the QA seed and the route tests start from: one alert of every kind. */
export function defaultCatalogs(now = Date.now()) {
  return {
    claude: [
      claudeModel('claude-opus-5-5', 'Opus 5.5', 'Opus', '2.1.280'),
      claudeModel('claude-opus-5-6', 'Opus 5.6', 'Opus', '2.1.280'),
      claudeModel('claude-opus-5', 'Opus 5', 'Opus'),
      claudeModel('claude-fable-5-1', 'Fable 5.1', 'Fable', '2.1.251'),
      claudeModel('claude-sonnet-5', 'Sonnet 5', 'Sonnet'),
      claudeModel('claude-sonnet-5-1', 'Sonnet 5.1', 'Sonnet', '9.0.0'),
      // haiku's pinned id is left out on purpose: Vanished.
      claudeModel('claude-haiku-4-4', 'Haiku 4.4', 'Haiku'),
    ],
    claudeFetchedAt: now - HOUR,
    codex: [
      codexModel('gpt-6-astra', 'GPT-6-Astra'),
      codexModel('gpt-6-sol', 'GPT-6-Sol'),
      codexModel('gpt-7-sol', 'GPT-7-Sol', 'hide'),
      codexModel('codex-9-sol', 'Codex 9 Sol'),
      codexModel('gpt-5.6-sol', 'GPT-5.6-Sol'),
      codexModel('gpt-5.6-terra', 'GPT-5.6-Terra', 'list', {
        model: 'gpt-6-sol', migration_markdown: 'Terra is retiring; move to Sol.', retirement_at: '2026-12-01T19:00:00Z',
      }),
      codexModel('gpt-5.5', 'GPT-5.5', 'list', {
        model: 'gpt-5.6-sol', migration_markdown: 'Move to 5.6.', retirement_at: '2026-10-14T19:00:00Z',
      }),
      codexModel('gpt-reserve', 'GPT-Reserve', 'hide'),
      codexModel('codex-auto-review', 'Codex Auto Review', 'hide'),
    ],
    codexFetchedAt: now - HOUR,
    grok: [
      grokModel('grok-4.7', 'Grok 4.7'),
      grokModel('grok-4.8-build-fast', 'Grok 4.8 Fast'),
      grokModel('grok-4.9', 'Grok 4.9', true),
      grokModel('grok-4.6', 'Grok 4.6'),
      grokModel('grok-4.5', 'Grok 4.5'),
    ],
    grokFetchedAt: now - HOUR,
  };
}

const write = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
};

export function writeClaudeCatalog(home, models, fetchedAt, name = `${MARKERS.filename}-cc.json`) {
  write(path.join(home, '.claude', 'cache', 'model-catalog', name), {
    version: 1, fetchedAt, staleAt: fetchedAt + HOUR,
    catalog: { surface: 'cc', config: { id: 'cfg', models, settings_vocabulary: {} }, state: { id: 's', model: 'x', selection_source: 'default', thinking: { type: 'auto', effort: 'medium' }, thinking_by_model: [] } },
  });
}

export function writeCodexCatalog(codexHome, models, fetchedAt, clientVersion = '0.156.0') {
  write(path.join(codexHome, 'models_cache.json'), {
    fetched_at: iso(fetchedAt), etag: MARKERS.etag, client_version: clientVersion, identity: MARKERS.identity, models,
  });
}

export function writeGrokCatalog(home, models, fetchedAt, renewedAt = fetchedAt) {
  const map = {};
  for (const m of models) map[m.info.id] = m;
  write(path.join(home, '.grok', 'models_cache.json'), {
    fetched_at: iso(fetchedAt), renewed_at: renewedAt == null ? undefined : iso(renewedAt), grok_version: '0.9.0',
    auth_method: MARKERS.auth, origin: MARKERS.origin, identity: MARKERS.identity, etag: MARKERS.etag, models: map,
  });
}

/** A fake CLI that answers --version and nothing else. */
export function fakeCli(file, version) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!${process.execPath}\nif (process.argv[2] === '--version') console.log(${JSON.stringify(version)});\n`, { mode: 0o755 });
}

/**
 * A fresh temp HOME: catalogs, a fake claude/grok, settings.json with a
 * modelSettings entry and a top-level model, config.toml, and a skill that
 * calls `model-id opus`.
 */
export function seedHome({ prefix = 'acs-models-', claudeVersion = '2.1.300 (Claude Code)', catalogs = defaultCatalogs() } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  writeClaudeCatalog(home, catalogs.claude, catalogs.claudeFetchedAt);
  writeCodexCatalog(path.join(home, '.codex'), catalogs.codex, catalogs.codexFetchedAt);
  writeGrokCatalog(home, catalogs.grok, catalogs.grokFetchedAt);
  fakeCli(path.join(home, '.local', 'bin', 'claude'), claudeVersion);
  fakeCli(path.join(home, '.grok', 'bin', 'grok'), '0.9.0');
  write(path.join(home, '.claude', 'settings.json'),
    '{\n  "model": "claude-opus-5-5",\n  "theme": "dark",\n  "modelSettings": {\n    "claude-opus-5-5": { "effortLevel": "medium" },\n' +
    '    "claude-sonnet-5": {\n      "effortLevel": "high"\n    }\n  },\n  "permissions": { "allow": [] }\n}\n');
  write(path.join(home, '.codex', 'config.toml'),
    'model = "gpt-6-sol"\nmodel_reasoning_effort = "high"\n\n[profiles.review]\nmodel = "gpt-6-sol"\n');
  write(path.join(home, '.claude', 'skills', 'review', 'SKILL.md'),
    '---\nname: review\n---\nRun `claude -p --model "$(model-id opus 2>/dev/null || echo MODEL-ID-UNRESOLVED-opus)"` <!-- fixture-review-skill -->\n' +
    'Opus is the reviewer here; that prose line is not a callsite.\n' +
    'Pinned previous: $(model-id grok-prev 2>/dev/null || echo x)\n');
  fs.mkdirSync(path.join(home, 'Documents', 'Projects'), { recursive: true });
  return home;
}
