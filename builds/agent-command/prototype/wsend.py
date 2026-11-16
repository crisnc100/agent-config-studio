#!/usr/bin/env python3
"""Experiment: send a follow-up into a worker pane and block until that surface's next Stop."""
import json, os, subprocess, sys, time
ref, uuid, msg = sys.argv[1], sys.argv[2], sys.argv[3]
ev = os.path.expanduser('~/.cmuxterm/events.jsonl'); env = dict(os.environ, CMUX_QUIET='1')
size = os.path.getsize(ev); t0 = time.time()
subprocess.run(['cmux', 'send', '--surface', ref, msg], env=env, capture_output=True)
subprocess.run(['cmux', 'send-key', '--surface', ref, 'enter'], env=env, capture_output=True)
submitted = False
with open(ev) as f:
    f.seek(size)
    while time.time() - t0 < 300:
        line = f.readline()
        if not line:
            if not submitted and time.time() - t0 > 1.5:   # text sat in the composer: press enter once more
                subprocess.run(['cmux', 'send-key', '--surface', ref, 'enter'], env=env, capture_output=True); submitted = True
                print(f'second enter at {time.time()-t0:.2f}s')
            time.sleep(0.1); continue
        try: e = json.loads(line)
        except Exception: continue
        if (e.get('surface_id') or '').upper() != uuid.upper(): continue
        n = e.get('name', '')
        if n == 'agent.hook.UserPromptSubmit' and not submitted: submitted = True; print(f'submitted: {time.time()-t0:.2f}s')
        if n == 'agent.hook.Stop': print(f'Stop: {time.time()-t0:.2f}s'); break
