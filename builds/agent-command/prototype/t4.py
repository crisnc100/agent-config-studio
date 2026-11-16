import json, os, subprocess, sys, time
d = sys.argv[1]; S = os.path.dirname(__file__)
env = dict(os.environ, CMUX_QUIET='1'); EV = os.path.expanduser('~/.cmuxterm/events.jsonl')
off = os.path.getsize(EV); t0 = time.time()
script = os.path.join(os.environ.get('TMPDIR','/tmp'), 'stuck.sh')
open(script,'w').write(f"#!/bin/sh\ncd '{d}'\nexec claude --model claude-opus-5-5 --effort medium --permission-mode default \"$(cat '{d}/prompt.md')\"\n"); os.chmod(script, 0o755)
o = json.loads(subprocess.run(['cmux','--json','--id-format','both','new-pane','--direction','right','--focus','false','--command',script],capture_output=True,text=True,env=env).stdout)
sid, ref = o['surface_id'].upper(), o['surface_ref']
state = 'waiting'
with open(EV) as f:
    f.seek(off)
    while time.time() - t0 < 180:
        l = f.readline()
        if not l: time.sleep(0.1); continue
        try: e = json.loads(l)
        except Exception: continue
        if (e.get('surface_id') or '').upper() != sid: continue
        n = e.get('name','')
        if n == 'agent.hook.PermissionRequest' and state == 'waiting':
            print(f'stuck detected at {time.time()-t0:.1f}s; tool={(e.get("payload") or {}).get("tool_name")}')
            time.sleep(0.5)
            scr = subprocess.run(['cmux','read-screen','--surface',ref],capture_output=True,text=True,env=env).stdout
            q = [x.strip() for x in scr.splitlines() if 'date' in x or 'proceed' in x.lower()][:3]
            print('screen says:', q)
            subprocess.run(['cmux','send','--surface',ref,'1'],env=env,capture_output=True)
            print(f'answered "1. Yes" at {time.time()-t0:.1f}s'); state = 'answered'
        if n == 'agent.hook.Stop' and state == 'answered':
            print(f'finished at {time.time()-t0:.1f}s'); break
print('RESULT:', open(f'{d}/RESULT.txt').read().strip() if os.path.exists(f'{d}/RESULT.txt') else None, ref)
