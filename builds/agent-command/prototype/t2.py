"""Test 2: ten workers at once, small task each; all must finish, answers checked, load sampled."""
import json, os, subprocess, sys, time
sys.path.insert(0, os.path.dirname(__file__)); import done
S = os.path.dirname(__file__); T = sys.argv[1]; fams = sys.argv[2:]
env = dict(os.environ, CMUX_QUIET='1')
env['AGENT_HOME_PANE'] = json.loads(subprocess.run(['cmux','--json','identify'],capture_output=True,text=True,env=env).stdout)['caller']['pane_ref']
wp = json.loads(subprocess.run(['cmux','--json','new-pane','--direction','right','--focus','false'],capture_output=True,text=True,env=env).stdout)['pane_ref']
env['AGENT_WORKER_PANE'] = wp
W = {}; off = os.path.getsize(done.EV); t0 = time.time()
for i, fam in enumerate(fams):
    k = f'{fam}{i}'; d = f'{T}/ten/{k}'; os.makedirs(d, exist_ok=True)
    for f in os.listdir(d): os.remove(os.path.join(d, f))
    n = 17 + i
    open(f'{d}/prompt.md', 'w').write(f'Compute {n} * {n+1}. Write only the number to RESULT.txt in the current folder, then reply DONE.')
    o = json.loads(subprocess.run(['python3', f'{S}/agent.py', 'open', fam, 'medium' if fam in ('opus','sol','terra') else '-', d, f'{d}/prompt.md'], capture_output=True, text=True, env=env).stdout)
    W[k] = dict(d=d, ref=o['surface_ref'], sid=o['surface_id'], model=o['model'], want=str(n*(n+1)))
print(f'opened {len(W)} in {time.time()-t0:.1f}s; load {os.getloadavg()[0]:.1f}')
def turns(w):
    m = w['model']
    if m.startswith('gpt-'): return done.codex_turns(w['d'], t0 - 5)
    if m.startswith('grok-'): return done.grok_turns(w['d'], t0 - 5)
    return done.claude_turns(w['sid'], off)
pend = set(W); peak = 0
while pend and time.time() - t0 < 600:
    peak = max(peak, os.getloadavg()[0])
    for k in list(pend):
        if turns(W[k]) >= 1: W[k]['t'] = round(time.time()-t0, 1); pend.discard(k)
    time.sleep(0.5)
for k, w in W.items():
    r = os.path.join(w['d'], 'RESULT.txt'); got = open(r).read().strip() if os.path.exists(r) else None
    print(f"{k:7s} done {w.get('t')}s  result {got}  {'ok' if got == w['want'] else 'WRONG/none'}  {w['ref']}")
print(f'all done {time.time()-t0:.1f}s; peak load {peak:.1f}; cores {os.cpu_count()}')
