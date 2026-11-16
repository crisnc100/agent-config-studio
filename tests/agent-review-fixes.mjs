import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/cleanup.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.realpathSync(tempDir('acs-agent-review-fixes-'));
process.env.HOME = home;
for (const key of ['CODEX_HOME', 'GROK_HOME', 'CLAUDE_CONFIG_DIR']) delete process.env[key];
const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'cmux'), `#!${process.execPath}\nimport(${JSON.stringify(path.join(root, 'tests/fixtures/agent-cmux.mjs'))});\n`, { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'caffeinate'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
const capture = path.join(home, 'capture.json');
for (const vendor of ['codex', 'claude', 'grok']) fs.writeFileSync(path.join(bin, vendor), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify({argv:process.argv.slice(2),home:process.env[${JSON.stringify({codex:'CODEX_HOME',claude:'CLAUDE_CONFIG_DIR',grok:'GROK_HOME'}[vendor])}]}));\n`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
const env = () => ({ ...process.env, CMUX_SOCKET_PATH: 'fake', CMUX_WORKSPACE_ID: 'workspace:1' });
const cli = (args, extra = {}) => spawnSync(process.execPath, [path.join(root, 'bin/agent.mjs'), ...args], { env: { ...env(), ...extra }, encoding: 'utf8', timeout: 15000 });
const json = r => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
const { waitWorker, sendWorker, listWorkers, openWorker, answerWorker } = await import('../lib/agent.js');
const records = path.join(home, '.agent-config-studio/agents'); fs.mkdirSync(records, { recursive: true });
const events = path.join(home, '.cmuxterm/events.jsonl'); fs.mkdirSync(path.dirname(events)); fs.writeFileSync(events, '');
const statePath = path.join(home, 'fake-cmux.json');
const state = () => fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath)) : { n: 0, panes: ['pane:1','pane:2'], calls: [], workers: {} };
const mutate = fn => { const s = state(); fn(s); fs.writeFileSync(statePath, JSON.stringify(s)); };
const ctx = { workspace: 'workspace:1', pane: 'pane:1' };
const epoch = Date.now() - 40 * 60000;
let clock = epoch;
const runtime = { now: () => clock, sleep: async ms => { clock += ms; }, commandAfter: 10 };
const stamp = () => new Date(clock).toISOString();
const started = v => v === 'codex' ? { type: 'event_msg', timestamp: stamp(), payload: { type: 'task_started' } } : v === 'claude' ? { type: 'user', timestamp: stamp(), message: { content: 'user task' } } : { type: 'turn_started', timestamp: stamp() };
const done = v => v === 'codex' ? { type: 'event_msg', timestamp: stamp(), payload: { type: 'task_complete', last_agent_message: 'done' } } : v === 'claude' ? { type: 'assistant', timestamp: stamp(), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } } : { type: 'turn_ended', timestamp: stamp() };
function worker(vendor, entries = []) {
  const id = crypto.randomUUID(), runDir = path.join(records, id); fs.mkdirSync(runDir);
  const transcript = path.join(runDir, 'events.jsonl'); fs.writeFileSync(transcript, entries.map(e => JSON.stringify(e)+'\n').join('')); fs.utimesSync(transcript, clock/1000,clock/1000);
  const history = vendor === 'grok' ? path.join(runDir,'chat_history.jsonl') : null;
  if (history) fs.writeFileSync(history,'');
  const w = { id, vendor, history, family: vendor, cwd: runDir, runDir, transcript, session: id, surface_ref: `surface:${id}`, surface_id: id, pane_ref: 'pane:2', workspace: ctx.workspace, orchestratorPane: ctx.pane, status: 'running', openedAt: epoch, lastActivityAt: epoch, completed: 0, turnComplete: 0, eventStart: 0, baseline: [] };
  fs.writeFileSync(path.join(records, `${id}.json`), JSON.stringify(w));
  mutate(s => { if (!s.panes.includes('pane:2')) s.panes.push('pane:2'); s.workers[w.surface_ref] = { ...w, screen: 'Worker screen' }; });
  return w;
}
const append = (w, e) => { fs.appendFileSync(w.transcript, JSON.stringify(e)+'\n'); fs.utimesSync(w.transcript, clock/1000,clock/1000); };
const record = w => JSON.parse(fs.readFileSync(path.join(records, `${w.id}.json`)));
const show = (w, screen) => mutate(s => { s.workers[w.surface_ref].screen = screen; });
const tool = (id = 'a') => ({ type: 'assistant', timestamp: stamp(), message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `command ${id}` } }] } });
const result = (id = 'a') => ({ type: 'user', timestamp: stamp(), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'finished' }] } });
const permission = (w, id = 'a') => fs.appendFileSync(events, JSON.stringify({ name: 'agent.hook.PermissionRequest', surface_id: w.surface_id, occurred_at: stamp(), payload: { tool_use_id: id } })+'\n');
const inputCalls = w => state().calls.filter(a => (a.includes('send') || a.includes('send-key')) && a.includes(w.surface_ref));
const cases = {
  async b6f1() {
    for (const vendor of ['codex','claude','grok']) {
      clock = Date.now(); const w = worker(vendor);
      let launched=false;
      const lateLaunch = { now:()=>clock, sleep:async ms=>{clock+=ms;if(!launched){append(w,started(vendor));launched=true;}} };
      await assert.rejects(sendWorker(w.id,'unsubmitted correction',ctx,lateLaunch),/startup|launch turn/);
      assert.equal(inputCalls(w).length,0,'nothing is typed before the launch turn is observed');
      assert.equal(record(w).pendingSend,undefined);
      const legacy=worker(vendor);
      const saved=record(legacy); saved.pendingSend={sentAt:clock-11000,startedBefore:0};
      fs.writeFileSync(path.join(records,`${legacy.id}.json`),JSON.stringify(saved));
      append(legacy,started(vendor));
      assert.equal((await waitWorker(legacy.id,0,ctx,runtime)).state,'unsent','a late launch cannot confirm a legacy pending send');
      assert.equal(record(legacy).pendingSend.confirmedAt,undefined);
      append(legacy,started(vendor));
      await waitWorker(legacy.id,0,ctx,runtime);
      assert.ok(record(legacy).pendingSend.confirmedAt,'only a turn after launch can confirm a legacy send');
      const closed=record(legacy); closed.status='closed'; fs.writeFileSync(path.join(records,`${legacy.id}.json`),JSON.stringify(closed));
      append(w,started(vendor));
      await sendWorker(w.id,'correction after startup',ctx,runtime);
      assert.ok(record(w).pendingSend.confirmedAt,'a subsequent turn confirms the correction');
    }
  },
  async b6f2() {
    for (const vendor of ['codex','claude','grok']) {
      clock = Date.now(); const w = worker(vendor,[started(vendor),done(vendor)]);
      process.env.FAKE_NO_SUBMIT='1';
      try { await assert.rejects(sendWorker(w.id,'first correction',ctx,runtime),/submission/); }
      finally { delete process.env.FAKE_NO_SUBMIT; }
      show(w,'› first correction');
      const pending=record(w).pendingSend, count=inputCalls(w).length;
      await assert.rejects(sendWorker(w.id,'replacement correction',ctx,runtime),error=>error.exitCode===5 && /unsent/.test(error.message) && /first correction/.test(error.message));
      assert.equal(inputCalls(w).length,count,'retry cannot append text or press Enter');
      assert.deepEqual(record(w).pendingSend,pending,'refusal preserves the unresolved attempt');
      const response=cli(['send',w.id,'replacement correction']);
      assert.equal(response.status,5,response.stderr); assert.match(response.stderr,/unsent.*first correction/);
      assert.equal(inputCalls(w).length,count);
      append(w,started(vendor)); append(w,done(vendor)); show(w,'Worker screen');
      mutate(s=>{s.workers[w.surface_ref].pending='';});
      await sendWorker(w.id,'after manual submission',ctx,runtime);
      assert.ok(record(w).pendingSend.confirmedAt,'manual submission reconciles the old pending attempt');
      const entries=fs.readFileSync(vendor==='grok'?w.history:w.transcript,'utf8').trim().split('\n').map(line=>JSON.parse(line));
      const texts=entries.flatMap(e=>vendor==='codex'?(e.payload?.type==='user_message'?[e.payload.message]:[]):vendor==='claude'?(e.type==='user'?[e.message.content]:[]):e.role==='user'?[e.content]:[]);
      assert.equal(texts.at(-1),'after manual submission','the reconciled next message is submitted without concatenation');
    }
  },
  async b6f3() {
    const question='Do you want to proceed?\n1. Yes\n2. No\nQUESTION: Choose yes or no.';
    for (const vendor of ['codex','claude','grok']) {
      clock = Date.now();
      const end=done(vendor);
      if(vendor==='codex')end.payload.last_agent_message=question;
      else if(vendor==='claude')end.message.content[0].text=question;
      const w=worker(vendor,[started(vendor),end]);
      show(w,question);
      const waited=await waitWorker(w.id,0,ctx,runtime);
      assert.equal(waited.state,'done'); assert.equal(waited.question,true); assert.equal(waited.text,question);
      await sendWorker(w.id,'Yes',ctx,runtime);
      assert.ok(inputCalls(w).some(a=>a.includes('send-key')),'completed choice text permits a reply');
      clock=Math.max(clock,Date.now())+1000; permission(w,'new');
      await assert.rejects(sendWorker(w.id,'not permission',ctx,runtime),/stuck/,'a new hook still blocks after completion');
      const active=worker(vendor,[started(vendor)]); show(active,question);
      await assert.rejects(sendWorker(active.id,'active dialog',ctx,runtime),/stuck/,'screen-only active approvals remain protected');
      assert.equal(inputCalls(active).length,0);
      for (const item of [w,active]) { const saved=record(item); saved.status='closed'; fs.writeFileSync(path.join(records,`${item.id}.json`),JSON.stringify(saved)); }
    }
  },
  async x1() {
    const approvalRuntime = { now: runtime.now, sleep: runtime.sleep };
    clock = epoch;
    const w = worker('claude',[started('claude'),tool()]);
    clock += 610000;
    permission(w);
    show(w,'Do you want to make this edit to example.js?\n❯ 1. Yes\n  2. No');
    await assert.rejects(sendWorker(w.id,'never approve',ctx,approvalRuntime),/stuck/);
    assert.equal(inputCalls(w).length,0,'a newer approval cannot receive text or Enter behind an old command');
    assert.equal((await waitWorker(w.id,0,ctx,approvalRuntime)).state,'stuck');
    show(w,'Worker screen');
    assert.equal((await waitWorker(w.id,0,ctx,approvalRuntime)).state,'long_command','observed dismissal retires the request');
    clock += 1000; permission(w,'b');
    await assert.rejects(sendWorker(w.id,'hook only',ctx,approvalRuntime),/stuck/);
    assert.equal(inputCalls(w).length,0,'an unresolved hook blocks even without a recognized screen');
    assert.equal((await waitWorker(w.id,0,ctx,approvalRuntime)).state,'stuck');
    const postStartTrust = worker('claude',[started('claude')]);
    show(postStartTrust,'Accessing workspace:\nYes, I trust this folder\nNo, exit');
    assert.equal((await waitWorker(postStartTrust.id,0,ctx,approvalRuntime)).state,'timeout','session start invalidates the startup wait state');
    await assert.rejects(sendWorker(postStartTrust.id,'do not trust',ctx,approvalRuntime),/stuck/);
    assert.equal(inputCalls(postStartTrust).length,0,'sending still checks the visible dialog independently of wait state');
    for (const question of ['Do you want to make this edit to example.js?', 'Do you want to create example.js?', 'Do you want to write to example.js?', 'Do you want to overwrite example.js?', 'Do you want to allow Claude to fetch this content?']) {
      const screenOnly = worker('claude',[started('claude'),tool()]);
      show(screenOnly,`${question}\n❯ 1. Yes\n  2. Yes, allow all edits during this session\n  3. No`);
      await assert.rejects(sendWorker(screenOnly.id,'screen only',ctx,approvalRuntime),/stuck/);
      assert.equal(inputCalls(screenOnly).length,0,question);
      assert.equal((await waitWorker(screenOnly.id,0,ctx,approvalRuntime)).state,'stuck');
    }
  },
  async x2() {
    for (const output of ['Would you like to proceed?', 'Do you want to proceed?\n1. Yes\n2. No\n'+Array.from({length:30},(_,i)=>`Answer line ${i}`).join('\n')]) {
      clock = Date.now(); const w = worker('claude',[started('claude'),done('claude')]);
      show(w,output);
      assert.equal((await waitWorker(w.id,0,ctx,runtime)).state,'done');
      await sendWorker(w.id,'a normal follow-up',ctx,runtime);
      assert.ok(inputCalls(w).some(a=>a.includes('send-key')),'ordinary answer and scrollback do not block submission');
    }
  },
  async g1answer() {
    clock = Date.now(); const w = worker('grok',[started('grok')]);
    show(w,'An unfinished screen is not an answer');
    assert.throws(()=>answerWorker(w.id,ctx),/no answer yet \(state running\)/);
    const response=cli(['answer',w.id]);
    assert.notEqual(response.status,0); assert.equal(response.stdout,''); assert.match(response.stderr,/no answer yet \(state running\)/);
  },
  async g1() {
    clock = Date.now(); const w = worker('grok');
    const saved=record(w); saved.session=null; saved.transcript=null; saved.openedAt=clock-150000;
    fs.writeFileSync(path.join(records,`${w.id}.json`),JSON.stringify(saved));
    show(w,fs.readFileSync(path.join(root,'tests/fixtures/agent-screens/grok-trust-narrow.txt'),'utf8'));
    assert.equal((await waitWorker(w.id,0,ctx,runtime)).state,'stuck');
    await assert.rejects(sendWorker(w.id,'never trust',ctx,runtime),/stuck/);
    assert.equal(inputCalls(w).length,0);
    assert.throws(()=>answerWorker(w.id,ctx),/no answer yet \(state stuck\)/);
    const response=cli(['answer',w.id]);
    assert.notEqual(response.status,0); assert.match(response.stderr,/no answer yet \(state stuck\)/); assert.equal(response.stdout,'');
    for (const vendor of ['codex','claude','grok']) {
      const active=worker(vendor,[started(vendor)]);
      assert.throws(()=>answerWorker(active.id,ctx),/no answer yet \(state running\)/);
      const unfinished=worker(vendor,[started(vendor),done(vendor),started(vendor)]);
      assert.throws(()=>answerWorker(unfinished.id,ctx),/no answer yet \(state running\)/,'a prior turn is not the current answer');
    }
    const fallback=worker('grok',[started('grok'),done('grok')]); show(fallback,'Completed answer');
    assert.equal(answerWorker(fallback.id,ctx),'Completed answer','screen fallback remains available after completion');
  },

  async f1() {
    for (const [family, variable] of [['sol','CODEX_HOME'], ['opus','CLAUDE_CONFIG_DIR'], ['grok','GROK_HOME']]) {
      const launchHome = path.join(home, `private ${family}`);
      const w = json(cli(['open', family, '--cwd', home, 'task', '--json'], { [variable]: launchHome }));
      const waited = cli(['wait', w.id, '--timeout','0','--json'], { [variable]: path.join(home,'wrong-home') });
      assert.equal(waited.status, 0, `${variable}: ${waited.stdout} ${waited.stderr}`);
      assert.equal(cli(['answer',w.id], { [variable]: path.join(home,'wrong-home') }).stdout, 'exact\nanswer  ');
      assert.equal(record(w).harnessHome, launchHome);
      const shell = spawnSync('/bin/sh', [w.launcher], { env: { ...env(), [variable]: path.join(home,'wrong-home') }, encoding: 'utf8' });
      assert.equal(shell.status,0,shell.stderr); assert.equal(JSON.parse(fs.readFileSync(capture)).home, launchHome);
    }
    const defaults = json(cli(['open','opus','--cwd',home,'task','--json']));
    assert.equal(spawnSync('/bin/sh',[defaults.launcher],{env:{...env(),CLAUDE_CONFIG_DIR:path.join(home,'inherited-wrong')},encoding:'utf8'}).status,0);
    assert.equal(JSON.parse(fs.readFileSync(capture)).home,undefined,'an unset launch override stays unset');
  },
  async f2() {
    for (const vendor of ['codex','claude','grok']) {
      clock = epoch; const w = worker(vendor,[started(vendor),done(vendor)]);
      assert.equal((await waitWorker(w.id,0,ctx,runtime)).state,'done');
      clock = Date.now(); append(w,started(vendor));
      if (vendor === 'claude') {
        append(w,tool());
        fs.appendFileSync(events,JSON.stringify({name:'agent.hook.Stop',surface_id:w.surface_id,occurred_at:new Date(clock+100).toISOString()})+'\n');
        fs.appendFileSync(events,JSON.stringify({name:'agent.hook.Stop',surface_id:w.surface_id,occurred_at:new Date(clock+200).toISOString()})+'\n');
      }
      assert.equal((await waitWorker(w.id,0,ctx,runtime)).state,'timeout', `${vendor}: direct turn is running`);
      assert.ok(record(w).lastActivityAt >= clock);
      assert.equal(listWorkers(ctx).find(r=>r.id===w.id).status,'running');
      clock += 11000;
      if (vendor === 'claude') assert.equal((await waitWorker(w.id,0,ctx,runtime)).state,'long_command');
      else { clock += 301000; assert.equal((await waitWorker(w.id,0,ctx,runtime)).state,'stalled','direct turns keep stall checks'); }
      append(w,done(vendor));
      assert.equal((await waitWorker(w.id,0,ctx,runtime)).state,'done');
    }
    const four=[];
    for (let i=0;i<4;i++) {
      clock=Date.now(); const w=worker('codex',[started('codex'),done('codex')]);
      await waitWorker(w.id,0,ctx,runtime); append(w,started('codex')); four.push(w);
    }
    let opened=null;
    const queued=openWorker('sol',{cwd:home,prompt:'queued task'},ctx).then(w=>opened=w);
    try { await new Promise(resolve=>setTimeout(resolve,60)); assert.equal(opened,null,'four direct turns occupy all worker slots'); }
    finally { const w=record(four[0]); w.status='closed'; fs.writeFileSync(path.join(records,`${w.id}.json`),JSON.stringify(w)); }
    await queued; assert.ok(opened.id);
  },
  async f3() {
    clock = epoch;
    const w = worker('claude',[started('claude'),tool('a')]);
    clock += 1000; permission(w,'a'); show(w,'Do you want to proceed?\n1. Yes\n2. No');
    assert.equal((await waitWorker(w.id,0,ctx,runtime)).state,'stuck');
    clock += 100; append(w,result('unrelated'));
    assert.equal((await waitWorker(w.id,0,ctx,runtime)).state,'stuck','an unrelated result cannot resolve an identified request');
    clock += 1000; append(w,result('a')); append(w,tool('b')); show(w,'Worker screen');
    clock += 11000;
    assert.equal((await waitWorker(w.id,0,ctx,runtime)).state,'long_command','resolved request cannot mask a later command');
    clock += 1000; permission(w,'b'); show(w,'Do you want to proceed?\n1. Yes\n2. No');
    assert.equal((await waitWorker(w.id,0,ctx,{...runtime,commandAfter:600})).state,'stuck','a later request must still block');
    clock += 1000; append(w,started('claude')); show(w,'Worker screen');
    assert.equal((await waitWorker(w.id,0,ctx,runtime)).state,'timeout','a later turn retires the obsolete request');
    clock=Date.now(); const dismissed=worker('claude',[started('claude'),tool()]);
    clock+=1000; permission(dismissed); show(dismissed,'Do you want to proceed?\n1. Yes\n2. No');
    assert.equal((await waitWorker(dismissed.id,0,ctx,runtime)).state,'stuck');
    show(dismissed,'Worker screen'); clock+=11000;
    assert.equal((await waitWorker(dismissed.id,0,ctx,runtime)).state,'long_command','a dismissed dialog no longer hides its running command');
    clock=Date.now(); const unlabelled=worker('claude',[started('claude'),tool()]);
    clock+=1000; permission(unlabelled,null); show(unlabelled,'Do you want to proceed?\n1. Yes\n2. No');
    assert.equal((await waitWorker(unlabelled.id,0,ctx,runtime)).state,'stuck');
    clock+=1000; append(unlabelled,result()); append(unlabelled,tool('next')); show(unlabelled,'Worker screen'); clock+=11000;
    assert.equal((await waitWorker(unlabelled.id,0,ctx,runtime)).state,'long_command','timestamped results also resolve hooks without call ids');
  },
  async s1() {
    const prompt = '--config=mcp_servers.evil={command="sh",args=["-c","printf harmless"]}';
    const file = path.join(home,'attacker-task.md'); fs.writeFileSync(file,prompt);
    for (const family of ['sol','opus','grok']) {
      const w = json(cli(['open',family,'--cwd',home,'--prompt-file',file,'--json']));
      assert.equal(spawnSync('/bin/sh',[w.launcher],{env:env(),encoding:'utf8'}).status,0);
      const argv = JSON.parse(fs.readFileSync(capture)).argv;
      assert.equal(argv.at(-2),'--',`${family}: prompt must follow the option delimiter`);
      assert.equal(argv.at(-1),prompt);
      assert.ok(!argv.slice(0,argv.indexOf('--')).some(a=>a.includes('mcp_servers.evil')));
    }
  },
  async s2() {
    for (const vendor of ['claude','codex','grok']) for (const kind of ['trust','permission']) {
      clock = Date.now();
      const w = worker(vendor,[started(vendor)]);
      if (kind === 'permission') { append(w,tool()); permission(w); show(w,'Do you want to proceed?\n1. Yes\n2. No'); }
      else {
        const saved=record(w); saved.session=null; saved.transcript=null; fs.writeFileSync(path.join(records,`${w.id}.json`),JSON.stringify(saved));
        show(w,vendor==='codex'?'Trust this folder?\n1. Trust and continue\n2. Quit':vendor==='grok'?'Do you trust the contents of this directory?\ny  Yes, proceed\nn  No, quit':'Accessing workspace:\nQuick safety check: Is this a project you trust?\nYes, I trust this folder\nNo, exit');
      }
      await assert.rejects(sendWorker(w.id,'Do not approve anything',ctx,runtime),/stuck/);
      assert.equal(inputCalls(w).length,0,`${vendor} ${kind}: no text or keys reach a dialog`);
      const refused=cli(['send',w.id,'Do not approve anything']);
      assert.equal(refused.status,3,refused.stderr); assert.match(refused.stderr,/stuck/);
      assert.equal(inputCalls(w).length,0,'CLI refusal also sends nothing');
      const saved=record(w); saved.status='closed'; fs.writeFileSync(path.join(records,`${w.id}.json`),JSON.stringify(saved));
    }
    for (const [flag, expectedKeys] of [['FAKE_PERMISSION_ON_SEND',0], ['FAKE_PERMISSION_AFTER_ENTER',1]]) {
      clock=Date.now(); const w=worker('claude',[started('claude'),done('claude')]);
      process.env[flag]='1';
      try { await assert.rejects(sendWorker(w.id,'correction',ctx,runtime),/stuck/); }
      finally { delete process.env[flag]; }
      assert.equal(inputCalls(w).filter(a=>a.includes('send-key')).length,expectedKeys,'stop before Enter can answer the new dialog');
    }
  },
};
let failures=0;
for (const [name, test] of Object.entries(cases)) {
  if (process.env.FIX_CASE && process.env.FIX_CASE !== name) continue;
  try { await test(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
  finally {
    for (const f of fs.readdirSync(records).filter(f=>f.endsWith('.json'))) { const file=path.join(records,f),w=JSON.parse(fs.readFileSync(file)); w.status='closed'; fs.writeFileSync(file,JSON.stringify(w)); }
  }
}
assert.equal(failures,0,'all review findings have regression coverage');
