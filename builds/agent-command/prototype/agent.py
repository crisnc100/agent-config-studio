#!/usr/bin/env python3
"""Prototype `agent open`: start any model family in a cmux pane, prompt from a file of any size.
Usage: agent.py open <family> <effort|-> <cwd> <prompt-file>   -> prints JSON {surface_ref, surface_id, launched_at}
       agent.py wait <surface_id> [timeout]                    -> prints when it started, stopped or got stuck"""
import json, os, shlex, subprocess, sys, time
env = dict(os.environ, CMUX_QUIET='1')
EV = os.path.expanduser('~/.cmuxterm/events.jsonl')
RUN = os.path.join(os.environ.get('TMPDIR', '/tmp'), 'agent-runs')

def harness(family, model, effort):
    if model.startswith('gpt-'):
        e = f" -c model_reasoning_effort={effort}" if effort else ''
        return f"codex -m {model}{e} -s workspace-write -a never"
    if model.startswith('claude-'):
        e = f" --effort {effort}" if effort else ''
        return f"claude --model {model}{e} --permission-mode auto"
    if model.startswith('grok-'):
        return f"grok -m {model} --permission-mode auto"
    sys.exit(f'no harness for {model}')

def open_(family, effort, cwd, pfile):
    model = subprocess.run(['model-id', family], capture_output=True, text=True).stdout.strip()
    effort = None if effort == '-' else effort
    os.makedirs(RUN, exist_ok=True)
    # The prompt never goes through the terminal: a launcher script reads it from the file.
    script = os.path.join(RUN, f'{family}-{int(time.time()*1000)}.sh')
    with open(script, 'w') as f:
        f.write(f'#!/bin/sh\ncd {shlex.quote(cwd)} || exit 1\nexec {harness(family, model, effort)} "$(cat {shlex.quote(os.path.abspath(pfile))})"\n')
    os.chmod(script, 0o755)
    t0 = time.time()
    grok = model.startswith('grok-')
    pane = os.environ.get('AGENT_WORKER_PANE')   # set: open as a tab in that pane, which never runs out of room
    args = (['new-surface', '--pane', pane] if pane else ['new-pane', '--direction', 'right'])
    out = json.loads(subprocess.run(['cmux', '--json', '--id-format', 'both', *args,
        '--focus', 'true' if grok else 'false', '--command', script], capture_output=True, text=True, env=env).stdout)
    if grok:   # grok's TUI waits for focus before it starts: hold it until its session exists, then hand it back
        me = os.environ.get('AGENT_HOME_PANE')
        import glob
        enc = glob.escape(cwd.replace('/', '%2F'))
        deadline = time.time() + 6
        while time.time() < deadline:
            if any(os.path.getmtime(d) >= t0 for d in glob.glob(os.path.expanduser(f'~/.grok/sessions/{enc}/*/'))): break
            time.sleep(0.1)
        if me: subprocess.run(['cmux', 'focus-pane', '--pane', me], env=env, capture_output=True)
    print(json.dumps({'family': family, 'model': model, 'effort': effort, 'surface_ref': out['surface_ref'],
                      'surface_id': out['surface_id'], 'open_s': round(time.time()-t0, 2), 'launched_at': t0}))

def wait(sid, timeout=600, since=None):
    t0 = time.time(); start = None
    with open(EV) as f:
        f.seek(0, 2) if since is None else None
        while time.time() - t0 < timeout:
            line = f.readline()
            if not line: time.sleep(0.1); continue
            try: e = json.loads(line)
            except Exception: continue
            if (e.get('surface_id') or '').upper() != sid.upper(): continue
            n = e.get('name', '')
            if n == 'agent.hook.UserPromptSubmit' and start is None: start = time.time()
            if n in ('agent.hook.Notification', 'agent.hook.PermissionRequest'): return 'stuck', time.time()
            if n == 'agent.hook.Stop': return 'done', time.time()
    return 'timeout', time.time()

def send(ref, msg):
    """Type a follow-up and make sure it was submitted: a TUI can leave the text sitting in its composer."""
    subprocess.run(['cmux', 'send', '--surface', ref, msg], env=env, capture_output=True)
    tail = msg[-25:]
    for _ in range(4):
        subprocess.run(['cmux', 'send-key', '--surface', ref, 'enter'], env=env, capture_output=True)
        time.sleep(1.2)
        scr = subprocess.run(['cmux', 'read-screen', '--surface', ref], capture_output=True, text=True, env=env).stdout
        flat = ''.join(scr.split())
        if ''.join(tail.split()) not in flat[-600:]: return True
    return False

if __name__ == '__main__':
    if sys.argv[1] == 'send': print(send(sys.argv[2], sys.argv[3])); sys.exit()
    if sys.argv[1] == 'open': open_(*sys.argv[2:6])
    elif sys.argv[1] == 'wait': print(wait(sys.argv[2], float(sys.argv[3]) if len(sys.argv) > 3 else 600))
