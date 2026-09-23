#!/usr/bin/env python3
"""Grade fix 1: every `$(model-id X)` in a skill gets `|| echo MODEL-ID-UNRESOLVED-X`, so a shell
where model-id is not on PATH substitutes a loudly-invalid id instead of an empty string.
Asserts the exact count per file before writing anything.

  python3 rewrite-fallback.py [--dry-run]
"""
import os, re, sys

H = os.path.expanduser('~')
# path → (count of $(model-id <family>), count of the $(model-id <codexModel>) placeholder)
FILES = {
    '.claude/skills/advisor/SKILL.md': (5, 1),
    '.claude/skills/delegating-to-agents/SKILL.md': (4, 0),
    '.claude/skills/investigate/SKILL.md': (2, 1),
    '.claude/skills/code-review/SKILL.md': (2, 0),
    '.claude/skills/build/SKILL.md': (7, 0),
    '.claude/skills/deep-review/SKILL.md': (1, 0),
    '.codex/skills/advisor/SKILL.md': (9, 1),
    '.codex/skills/investigate/SKILL.md': (2, 1),
    '.codex/skills/code-review/SKILL.md': (1, 0),
    '.codex/skills/deep-review/SKILL.md': (1, 0),
    '.codex/skills/build/SKILL.md': (6, 0),
}
FAM = re.compile(r'\$\(model-id ([a-z][a-z-]*)\)')
PH = '$(model-id <codexModel>)'

def main():
    out, errors = {}, []
    for rel, (nf, nph) in FILES.items():
        p = os.path.join(H, rel)
        s = open(p, encoding='utf-8').read()
        f, ph = len(FAM.findall(s)), s.count(PH)
        if (f, ph) != (nf, nph):
            errors.append(f'{rel}: expected {nf}+{nph}, found {f}+{ph}')
            continue
        s = FAM.sub(lambda m: f'$(model-id {m[1]} || echo MODEL-ID-UNRESOLVED-{m[1]})', s)
        s = s.replace(PH, '$(model-id <codexModel> || echo MODEL-ID-UNRESOLVED-<codexModel>)')
        out[p] = s
    if errors:
        print('\n'.join(errors)); sys.exit(1)
    if '--dry-run' not in sys.argv:
        for p, s in out.items():
            open(p, 'w', encoding='utf-8').write(s)
    print(f'{"checked" if "--dry-run" in sys.argv else "wrote"} {len(out)} files, {sum(a + b for a, b in FILES.values())} substitutions')

if __name__ == '__main__':
    main()
