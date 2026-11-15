"""Test 1: long prompt, then a follow-up in the same pane; does each worker keep its context?"""
import json, os, subprocess, sys, time
sys.path.insert(0, os.path.dirname(__file__)); import done
S = os.path.dirname(__file__); T = sys.argv[1]; fams = sys.argv[2:]
env = dict(os.environ, CMUX_QUIET='1')
env['AGENT_HOME_PANE'] = json.loads(subprocess.run(['cmux','--json','identify'],capture_output=True,text=True,env=env).stdout)['caller']['pane_ref']
W = {}
off = os.path.getsize(done.EV); t0 = time.time()
for fam in fams:
    d = f'{T}/w-{fam}'; os.makedirs(d, exist_ok=True)
    for f in os.listdir(d): os.remove(os.path.join(d, f))
    o = json.loads(subprocess.run(['python3', f'{S}/agent.py', 'open', fam, '-', d, f'{T}/prompt-{fam}.md'], capture_output=True, text=True, env=env).stdout)
    W[fam] = dict(d=d, ref=o['surface_ref'], sid=o['surface_id'], model=o['model'])
def turns(fam, w):
    m = w['model']
    if m.startswith('gpt-'): return done.codex_turns(w['d'], t0 - 5)
    if m.startswith('grok-'): return done.grok_turns(w['d'], t0 - 5)
    return done.claude_turns(w['sid'], off)
def wait_turn(k, label):
    pend = set(W)
    while pend and time.time() - t0 < 600:
        for fam in list(pend):
            if turns(fam, W[fam]) >= k: W[fam][label] = round(time.time() - t0, 1); pend.discard(fam)
        time.sleep(0.5)
wait_turn(1, 'turn1')
t1 = time.time()
for fam, w in W.items():
    msg = f'Follow-up, without re-reading any file: from the reference I gave you earlier, what is the text of the FIFTH level-2 heading? Write it as the only line of ANSWER2-{fam}.md, then reply DONE2.'
    w['sent'] = subprocess.run(['python3', f'{S}/agent.py', 'send', w['ref'], msg], capture_output=True, text=True, env=env).stdout.strip()
wait_turn(2, 'turn2')
for fam, w in W.items():
    a = os.path.join(w['d'], f'ANSWER2-{fam}.md')
    print(fam, 'sent', w.get('sent'), 'turn1', w.get('turn1'), 'turn2', w.get('turn2'), 'answer2:', open(a).read().strip() if os.path.exists(a) else None, w['ref'])
