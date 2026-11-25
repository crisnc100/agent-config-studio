import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootPage, routesFor, settle } from './fixtures/shell-page.mjs';

const builder = {
  name: 'builder', use: ['sol', 'opus'], ids: ['sol-id', 'opus-id'], effort: 'medium', alt: 'neon', altId: 'neon-id', note: 'Implements', warnings: [],
  members: [{ family: 'sol', own: 'high', effort: 'high' }, { family: 'opus', own: '', effort: 'medium' }],
  altMember: { family: 'neon', own: 'low', effort: 'low' },
};
const advisor = { name: 'advisor', use: ['astra'], ids: ['astra-id'], effort: 'high', alt: '', note: 'Advises', warnings: [] };

async function boot(t, { pick, stale = false } = {}) {
  const view = {
    roles: [{ ...builder, pick }, advisor], flavor: [], families: ['sol', 'opus', 'neon', 'astra'],
    efforts: ['low', 'medium', 'high'], limits: { note: 160 }, base: 'base-1', resolverStale: stale,
  };
  const calls = [];
  const page = await bootPage({ hash: '#models', routes: routesFor({
    'GET /api/models/roles': () => view,
    'POST /api/models/roles/set': (body) => {
      calls.push(body);
      if (stale) throw { status: 409, body: { error: 'Update model-id with acs install-model-id to save builder selection settings.' } };
      if (body.name === 'builder') view.roles[0].pick = body.fields.pick;
      return { saved: true, warnings: [] };
    },
    'GET /api/model-guide': () => ({ targets: [{ key: 'claude', status: view.roles[0].pick ? 'stale' : 'current' }] }),
  }) });
  t.after(() => page.done());
  await settle(10);
  const row = (name) => page.$('content').querySelector(`.roles-row[data-role="${name}"]`);
  const editor = () => page.$('content').querySelector('.roles-detail');
  const control = (type) => editor().querySelector(`.roles-builder-${type}`);
  const save = async () => {
    editor().querySelectorAll('button').find((button) => button.textContent === 'Save').click();
    await settle(10);
  };
  const change = (type, value) => {
    const input = control(type);
    input.value = value;
    input.dispatchEvent({ type: 'change', bubbles: false });
  };
  return { page, row, editor, control, calls, save, change };
}

test('builder controls offer the three strategies, save and reload with the existing role data', async (t) => {
  const ui = await boot(t);
  ui.row('advisor').click();
  assert.equal(ui.control('mode'), null);
  ui.row('advisor').click();
  ui.row('builder').click();
  assert.deepEqual(ui.control('mode').querySelectorAll('option').map((opt) => opt.textContent), ['First available', 'Random per task', 'Jev task fit']);
  assert.equal(ui.control('mode').value, 'ordered');
  assert.equal(ui.control('design').value, '');
  assert.equal(ui.control('design').querySelector('option').textContent, 'None');
  assert.equal(ui.control('usage').checked, false);
  assert.equal(ui.control('reserve').parentNode.hidden, true);
  ui.control('usage').click();
  ui.control('usage').click();
  await ui.save();
  assert.equal(Object.hasOwn(ui.calls[0].fields, 'pick'), false);
  assert.deepEqual(ui.calls[0].fields.use, [{ family: 'sol', effort: 'high' }, 'opus']);
  assert.deepEqual(ui.calls[0].fields.alt, { family: 'neon', effort: 'low' });

  ui.change('mode', 'random');
  ui.change('design', 'opus');
  ui.control('usage').click();
  assert.equal(ui.control('reserve').parentNode.hidden, false);
  assert.equal(ui.control('reserve').value, '0');
  ui.page.input(ui.control('reserve'), '101');
  await ui.save();
  assert.equal(ui.calls.length, 1);
  assert.match(ui.editor().querySelector('.models-write-error').textContent, /between 0 and 100/);
  ui.page.input(ui.control('reserve'), '17.5');
  await ui.save();
  assert.deepEqual(ui.calls[1].fields.pick, { mode: 'random', design: 'opus', reservePercent: 17.5 });
  assert.match(ui.row('builder').textContent, /Random per task/);
  assert.equal(ui.control('mode').value, 'random');
  assert.equal(ui.control('design').value, 'opus');
  assert.equal(ui.control('reserve').value, '17.5');
  assert.match(ui.page.$('notice-slot').textContent, /model guide.*needs updating/);

  ui.editor().querySelector('.roles-pick[data-family="opus"]').click();
  assert.equal(ui.control('design').value, 'opus');
  assert.match(ui.control('design').textContent, /Opus \(outside builder lineup\)/);
  ui.change('design', '');
  ui.change('mode', 'jev');
  ui.control('usage').click();
  await ui.save();
  assert.deepEqual(ui.calls[2].fields.pick, { mode: 'jev' });
  assert.match(ui.row('builder').textContent, /Jev task fit/);
  assert.equal(ui.control('usage').checked, false);
  assert.equal(ui.control('reserve').parentNode.hidden, true);
  ui.change('mode', 'ordered');
  await ui.save();
  assert.deepEqual(ui.calls[3].fields.pick, { mode: 'ordered' });
  assert.deepEqual(ui.page.errors, []);
});

test('a stale resolver shows its fix beside the builder editor and preserves the draft', async (t) => {
  const ui = await boot(t, { stale: true });
  assert.match(ui.page.$('content').querySelector('.models-resolver-stale').textContent, /acs install-model-id/);
  ui.row('builder').click();
  ui.change('mode', 'random');
  await ui.save();
  assert.match(ui.editor().querySelector('.models-write-error').textContent, /acs install-model-id.*builder selection settings/);
  assert.equal(ui.control('mode').value, 'random');
  assert.match(ui.row('builder').textContent, /First available/);
});
