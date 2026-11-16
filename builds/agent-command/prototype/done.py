"""Per-harness 'finished a turn' detection from each CLI's own files, plus 'stuck' from cmux."""
import glob, json, os, time
H = os.path.expanduser('~')
EV = f'{H}/.cmuxterm/events.jsonl'

def codex_turns(cwd, since):
    n = 0
    for f in glob.glob(f'{H}/.codex/sessions/*/*/*/rollout-*.jsonl'):
        if os.path.getmtime(f) < since: continue
        try:
            with open(f) as fh:
                first = json.loads(fh.readline())
                if (first.get('payload') or {}).get('cwd') != cwd: continue
                n += sum(1 for l in fh if '"task_complete"' in l)
        except Exception: pass
    return n

def grok_turns(cwd, since):
    n = 0
    enc = cwd.replace('/', '%2F')
    for d in glob.glob(f'{H}/.grok/sessions/{glob.escape(enc)}/*/'):
        f = d + 'events.jsonl'
        if os.path.exists(f) and os.path.getmtime(f) >= since:
            n += sum(1 for l in open(f) if '"turn_ended"' in l)
    return n

def claude_turns(sid, off):
    n = 0
    with open(EV) as f:
        f.seek(off)
        for l in f:
            if sid in l and '"agent.hook.Stop"' in l: n += 1
    return n

def stuck(sid, off):
    with open(EV) as f:
        f.seek(off)
        for l in f:
            if sid in l and '"agent.hook.PermissionRequest"' in l: return True
    return False
