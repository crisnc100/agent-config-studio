# Project-agnostic git worktree toolkit. Sourced from ~/.zshrc.
# Driven by .worktrees.conf at the TRUNK root (see wtinit).

: ${WT_HOME:=${HOME}/.config/worktree}

_wt_source() {
  source "$1"
  if [[ -z "$TRUNK" || -z "$ROOT" || ! -d "$TRUNK" ]]; then
    echo "wt: bad config at $1 — TRUNK/ROOT missing"
    return 1
  fi
  return 0
}

# Conf lives at TRUNK, which is often a linked worktree — not the primary.
_wt_conf() {
  unset TRUNK ROOT PREFIX BASE ENV_FILES PORTS POST_CREATE WT_DEV_CMD
  local git_common primary conf d key line wt_path wt_list
  # A per-project command (knew, stellanew, ...) names its own trunk, so it works
  # from anywhere. Everything else discovers the project from the cwd.
  if [[ -n "$WT_PIN_TRUNK" ]]; then
    _wt_source "$WT_PIN_TRUNK/.worktrees.conf"
    return $?
  fi
  if git_common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then
    primary="${git_common:h}"
    conf="$primary/.worktrees.conf"
    if [[ -f "$conf" ]]; then
      _wt_source "$conf"
      return $?
    fi
    wt_list=$(git --git-dir="$git_common" worktree list --porcelain 2>/dev/null) || wt_list=""
    while IFS= read -r line; do
      if [[ "$line" == worktree\ * ]]; then
        wt_path="${line#worktree }"
        if [[ -f "$wt_path/.worktrees.conf" ]]; then
          _wt_source "$wt_path/.worktrees.conf"
          return $?
        fi
      fi
    done <<< "$wt_list"
  fi
  d="$PWD"
  while true; do
    if [[ -f "$d/.worktrees.conf" ]]; then
      _wt_source "$d/.worktrees.conf"
      return $?
    fi
    [[ "$d" == / ]] && break
    d="${d:h}"
  done
  if [[ -n "$primary" ]]; then
    key="${primary:t}"
    conf="$HOME/.config/worktree/repos/${key}.conf"
    if [[ -f "$conf" ]]; then
      _wt_source "$conf"
      return $?
    fi
  fi
  echo "wt: no .worktrees.conf for this repo — run: wtinit"
  return 1
}

_wt_banner() {
  local dir="${1:-}" note="${2:-}" b sha port
  if [[ -z "$dir" ]]; then
    dir=$(git rev-parse --show-toplevel 2>/dev/null) || return 1
  fi
  printf '%-8s  %s\n' worktree "$dir"
  b=$(git -C "$dir" branch --show-current 2>/dev/null)
  if sha=$(git -C "$TRUNK" rev-parse --short "$BASE" 2>/dev/null); then
    printf '%-8s  %s   (off %s @ %s)\n' branch "$b" "$BASE" "$sha"
  else
    printf '%-8s  %s\n' branch "$b"
  fi
  if [[ -f "$dir/.worktree-port" ]]; then
    port=$(<"$dir/.worktree-port")
    printf '%-8s  %s\n' url "http://localhost:$port"
  elif [[ -n "$note" ]]; then
    printf '%-8s  %s\n' url "$note"
  fi
}

# ENV_FILES entries may be nested (backend/.env.local) — monorepos keep their
# secrets per package, and a worktree without them does not run.
# Fetch through direnv when an .envrc governs the trunk: repos under Garman-Homes
# get their GitHub identity from one, and a non-interactive shell (every agent)
# would otherwise authenticate as the wrong user, fail, and branch off a stale base.
_wt_fetch() {
  local out
  if [[ -n "${commands[direnv]}" ]] && direnv status "$TRUNK" 2>/dev/null | grep -q "Found RC"; then
    out=$(direnv exec "$TRUNK" git -C "$TRUNK" fetch --quiet origin 2>&1) && return 0
  else
    out=$(git -C "$TRUNK" fetch --quiet origin 2>&1) && return 0
  fi
  print -u2 -- "$out"
  return 1
}

# ---- Env files: one copy, in the trunk ------------------------------------
# Each ENV_FILES entry in a worktree is a link to the trunk's file, so a secret
# changes once. A worktree that needs its own value keeps a real copy by
# detaching it (`wenv --detach`), and that intent is recorded, so no relink
# ever quietly takes it back. Nothing here prints a file's contents.

# ENV_FILES as a list. A zsh array keeps each element whole — the only way an
# entry with a space can even be named, and refused; a string splits on space.
_wt_env_list() {
  reply=()
  if [[ ${(t)ENV_FILES} == array* ]]; then
    reply=("${ENV_FILES[@]}")
  else
    reply=(${=ENV_FILES})
  fi
}

# REPLY = why entry $1 cannot live in checkout $2, or "" when it can. Every
# parent that exists must resolve inside the checkout: a symlinked directory
# would carry the link, or a copy, somewhere else.
_wt_env_bad_path() {
  local f="$1" root="${2:A}" p part
  REPLY=""
  case "$f" in
    "") REPLY="empty entry"; return 0 ;;
    /*) REPLY="absolute path"; return 0 ;;
    *[[:space:]]*) REPLY="contains whitespace"; return 0 ;;
  esac
  for part in "${(@s:/:)f}"; do
    if [[ -z "$part" || "$part" == . || "$part" == .. ]]; then
      REPLY="has an empty, . or .. path component"
      return 0
    fi
  done
  [[ "$f" == */* ]] || return 0
  p="$root"
  for part in "${(@s:/:)${f:h}}"; do
    p="$p/$part"
    [[ -e "$p" || -L "$p" ]] || break
    if [[ ! -d "$p" ]]; then
      REPLY="parent ${p#$root/} is not a directory"
      return 0
    fi
    if [[ "${p:A}" != "$root"/* ]]; then
      REPLY="parent ${p#$root/} resolves outside the checkout"
      return 0
    fi
  done
  return 0
}

# REPLY = why entry $1 must not be a link in checkout $2, or "". A file git
# tracks there would become a committed change, and one it does not ignore
# could be committed as a link to this Mac's absolute path.
_wt_env_bad_git() {
  local f="$1" dir="$2" rc
  REPLY=""
  if git -C "$dir" ls-files --error-unmatch -- "$f" >/dev/null 2>&1; then
    REPLY="tracked by git"
    return 0
  fi
  git -C "$dir" check-ignore -q --no-index -- "$f" 2>/dev/null
  rc=$?
  (( rc == 0 )) && return 0
  if (( rc == 1 )); then REPLY="not gitignored"; else REPLY="git check-ignore failed"; fi
  return 0
}

# REPLY = every reason entry $1 is refused in checkout $2 (and at the trunk,
# where the source lives), or "".
_wt_env_refused() {
  _wt_env_bad_path "$1" "$2"
  [[ -n "$REPLY" ]] && return 0
  _wt_env_bad_path "$1" "$TRUNK"
  [[ -n "$REPLY" ]] && { REPLY="in the trunk: $REPLY"; return 0; }
  [[ "${2:A}" == "${TRUNK:A}" ]] && return 0
  _wt_env_bad_git "$1" "$2"
}

_wt_detached_has() {
  [[ -f "$2/.worktree-detached" ]] && grep -qxF -- "$1" "$2/.worktree-detached"
}

# REPLY = the state of entry $1 in checkout $2:
#   linked   a link resolving to the trunk's file
#   broken   a link to nothing
#   foreign  a link to something other than the trunk's file
#   detached a real file recorded by `wenv --detach`
#   copy     a real file byte-identical to the trunk's
#   stale    a real file that differs, or that the trunk does not have
#   missing  the trunk has it, this checkout does not
#   absent   neither has it
#   other    something that is not a file
_wt_env_state() {
  local f="$1" dir="$2" d="$2/$1" t="$TRUNK/$1"
  if [[ -L "$d" ]]; then
    if [[ ! -e "$d" ]]; then REPLY=broken
    elif [[ -f "$t" && "$d" -ef "$t" ]]; then REPLY=linked
    else REPLY=foreign
    fi
  elif [[ -f "$d" ]]; then
    if _wt_detached_has "$f" "$dir"; then REPLY=detached
    elif [[ -f "$t" ]] && cmp -s -- "$t" "$d"; then REPLY=copy
    else REPLY=stale
    fi
  elif [[ -e "$d" ]]; then REPLY=other
  elif [[ -f "$t" ]]; then REPLY=missing
  else REPLY=absent
  fi
}

# Put `$2/$1 -> TRUNK/$1` in place by rename, so a reader never sees it gone.
_wt_link_one() {
  local f="$1" d="$2/$1" tmp
  if [[ -d "$d" ]]; then
    echo "  refused: $f — a directory is in the way"
    return 1
  fi
  mkdir -p "${d:h}" || return 1
  tmp="${d:h}/.${d:t}.wt-link.$$"
  rm -f -- "$tmp"
  ln -s -- "${TRUNK:A}/$f" "$tmp" || return 1
  if ! mv -f -- "$tmp" "$d"; then
    rm -f -- "$tmp"
    return 1
  fi
}

# A real copy of the trunk's file at $2/$1, also swapped in by rename.
_wt_copy_one() {
  local f="$1" d="$2/$1" tmp
  tmp="${d:h}/.${d:t}.wt-copy.$$"
  rm -f -- "$tmp"
  if ! cp -p -- "$TRUNK/$f" "$tmp" || ! mv -f -- "$tmp" "$d"; then
    rm -f -- "$tmp"
    return 1
  fi
}

# Machine-local bookkeeping stays out of every branch: info/exclude lives in
# the common dir, so one line covers every worktree.
_wt_exclude() {
  local common gi
  common=$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  gi="$common/info/exclude"
  mkdir -p "${gi:h}"
  grep -qxF -- "$2" "$gi" 2>/dev/null || echo "$2" >> "$gi"
}

# Link every ENV_FILES entry into the new worktree $1. Existing entries are
# left alone: a fresh worktree has only what its branch tracks.
_wt_link_env() {
  local dir="$1" f miss=0
  _wt_env_list
  for f in "${reply[@]}"; do
    _wt_env_bad_path "$f" "$dir"
    [[ -n "$REPLY" ]] && { echo "  refused: $f — $REPLY"; continue; }
    if [[ ! -f "$TRUNK/$f" ]]; then
      # Only a problem if it was named explicitly; the default list is generic.
      [[ "$f" == */* ]] && { echo "  MISSING in trunk: $f"; miss=1; }
      continue
    fi
    _wt_env_refused "$f" "$dir"
    [[ -n "$REPLY" ]] && { echo "  refused: $f — $REPLY"; continue; }
    [[ -e "$dir/$f" || -L "$dir/$f" ]] && continue
    _wt_link_one "$f" "$dir" && echo "  linked $f"
  done
  (( miss )) && echo "  -> seed the trunk first:  wenv --to-trunk <source-worktree>"
  return 0
}

# REPLY = one word for the env of checkout $1 (see wls); reply = "file state" pairs.
_wt_env_summary() {
  local dir="$1" f s out="" k
  local -A n
  local -a pairs
  _wt_env_list
  for f in "${reply[@]}"; do
    _wt_env_refused "$f" "$dir"
    if [[ -n "$REPLY" ]]; then
      # A refused name that neither side has (the generic list's .envrc in a
      # repo that does not ignore it) is not worth a flag on every row.
      [[ -e "$TRUNK/$f" || -e "$dir/$f" || -L "$dir/$f" ]] || { pairs+=("$f" absent); continue; }
      s=refused
    else
      _wt_env_state "$f" "$dir"
      s="$REPLY"
    fi
    pairs+=("$f" "$s")
    [[ "$s" == absent ]] && continue
    (( n[$s]++ ))
  done
  for k in copy detached stale missing broken foreign other refused; do
    (( ${n[$k]:-0} )) && out+="${out:+,}$k:${n[$k]}"
  done
  if [[ -z "$out" ]]; then
    (( ${n[linked]:-0} )) && out=linked || out=-
  fi
  reply=("${pairs[@]}")
  REPLY="$out"
}

# REPLY = allowed | blocked for checkout $1's .envrc as direnv sees it, or "".
# Read-only: `direnv status` never authorises anything.
_wt_envrc_state() {
  local out
  REPLY=""
  [[ -e "$1/.envrc" ]] || return 0
  (( $+commands[direnv] )) || return 0
  out=$(cd "$1" 2>/dev/null && direnv status 2>/dev/null) || return 0
  if [[ "$out" == *"Found RC allowed 0"* ]]; then REPLY=allowed
  elif [[ "$out" == *"Found RC allowed "* ]]; then REPLY=blocked
  fi
}

# A failed `git status` is not a clean tree: "?" rather than 0.
_wt_dirty() {
  local out
  local -a lines
  out=$(git -C "$1" status --porcelain 2>/dev/null) || { echo "?"; return 0; }
  lines=(${(f)out})
  echo ${#lines}
}

# Every worktree of the project, from git's own NUL-separated list, into
# parallel arrays: _wt_p path, _wt_b branch ("" when detached), _wt_h HEAD,
# _wt_fl flags (" detached locked bare prunable").
_wt_list() {
  local out rec p="" b="" h="" fl=""
  typeset -ga _wt_p _wt_b _wt_h _wt_fl
  _wt_p=() _wt_b=() _wt_h=() _wt_fl=()
  out=$(git -C "$TRUNK" worktree list --porcelain -z 2>/dev/null) || return 1
  for rec in "${(@0)out}" ""; do
    if [[ -z "$rec" ]]; then
      if [[ -n "$p" ]]; then
        _wt_p+=("$p"); _wt_b+=("$b"); _wt_h+=("$h"); _wt_fl+=("$fl")
      fi
      p="" b="" h="" fl=""
      continue
    fi
    case "$rec" in
      worktree\ *) p="${rec#worktree }" ;;
      HEAD\ *) h="${rec#HEAD }" ;;
      branch\ *) b="${rec#branch }"; b="${b#refs/heads/}" ;;
      detached) fl+=" detached" ;;
      bare) fl+=" bare" ;;
      locked|locked\ *) fl+=" locked" ;;
      prunable|prunable\ *) fl+=" prunable" ;;
    esac
  done
  return 0
}

# REPLY = $1 as a JSON string.
_wt_js() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/\\r}"
  s="${s//[[:cntrl:]]/?}"
  REPLY="\"$s\""
}

_wt_pick_port() {
  local p claimed="" f
  for f in "$ROOT"/*/.worktree-port(N); do
    claimed="$claimed $(<"$f")"
  done
  for p in ${=PORTS}; do
    lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 && continue
    [[ " $claimed " == *" $p "* ]] && continue
    echo "$p"
    return 0
  done
  return 1
}

# wnew <name> : fresh worktree off $BASE, then drop you INTO it.
wnew() {
  _wt_conf || return 1
  [[ -z "$1" ]] && { echo "usage: wnew <name>"; return 1; }
  local name="$1" dir="$ROOT/$PREFIX$1" note="" p out
  if [[ -e "$dir" ]]; then
    echo "exists -> $dir"
    cd "$dir" || return 1
    _wt_banner "$dir"
    return 0
  fi
  # Branching off a stale base is the failure this whole tool exists to prevent,
  # so it stops rather than warning past it. WT_ALLOW_STALE=1 when offline.
  if ! _wt_fetch; then
    if [[ "$WT_ALLOW_STALE" == 1 ]]; then
      echo "wnew: fetch failed — using local $BASE (WT_ALLOW_STALE=1)"
    else
      echo "wnew: cannot reach origin, so $BASE may be stale. Nothing created."
      echo "      Fix the remote/auth, or re-run with:  WT_ALLOW_STALE=1 wnew $1"
      return 1
    fi
  fi
  mkdir -p "$ROOT"
  if git -C "$TRUNK" show-ref --verify --quiet "refs/heads/$name"; then
    echo "wnew: branch '$name' already exists — pick another name or: wgo $name"
    return 1
  fi
  git -C "$TRUNK" worktree add "$dir" -b "$name" "$BASE" || return 1
  _wt_link_env "$dir"
  # One `direnv allow`, for the new worktree only, and a failure is said out
  # loud: a silently blocked .envrc is a worktree that runs as the wrong user.
  if [[ -e "$dir/.envrc" ]]; then
    if (( $+commands[direnv] )); then
      out=$(cd "$dir" && direnv allow 2>&1) || echo "wnew: direnv allow failed, .envrc is blocked: ${out%%$'\n'*}"
    else
      echo "wnew: .envrc not allowed — direnv is not installed"
    fi
  fi
  if [[ -n "$PORTS" ]]; then
    if p=$(_wt_pick_port); then
      echo "$p" > "$dir/.worktree-port"
    else
      note="(all configured ports busy)"
    fi
  fi
  if [[ -n "$POST_CREATE" ]]; then
    echo "wnew: running post-create: $POST_CREATE"
    ( cd "$dir" && eval "$POST_CREATE" ) || echo "wnew: post-create failed (worktree still created)"
  fi
  cd "$dir" || return 1
  _wt_banner "$dir" "$note"
}

# wls [--json] : every worktree of this repo — branch, port, dirty count, env; off-book flagged.
wls() {
  _wt_conf || return 1
  local json=0 i trunk="${TRUNK:A}" root="${ROOT:A}" sep=""
  case "$1" in
    "") ;;
    --json) json=1 ;;
    *) echo "usage: wls [--json]"; return 1 ;;
  esac
  _wt_list || { echo "wls: git worktree list failed in $TRUNK"; return 1; }
  if (( json )); then
    _wt_js "$trunk"; print -rn -- "{\"trunk\":$REPLY,"
    _wt_js "$root"; print -rn -- "\"root\":$REPLY,"
    _wt_js "$BASE"; print -rn -- "\"base\":$REPLY,\"worktrees\":["
  fi
  for (( i = 1; i <= ${#_wt_p}; i++ )); do
    if (( json )); then
      print -rn -- "$sep"
      _wt_wls_json "$_wt_p[i]" "$_wt_b[i]" "$_wt_h[i]" "$_wt_fl[i]" "$trunk" "$root"
      sep=","
    else
      _wt_wls_row "$_wt_p[i]" "$_wt_b[i]" "$_wt_fl[i]" "$trunk" "$root"
    fi
  done
  (( json )) && print -r -- "]}"
  return 0
}

_wt_wls_row() {
  local wtdir="${1:A}" branch="$2" fl="$3" trunk="$4" root="$5"
  local port="-" dirty mark=" " extra="" label env
  label="${wtdir:t}"
  [[ " $fl " == *" detached "* ]] && branch="detached"
  [[ -z "$branch" ]] && branch="-"
  [[ -f "$wtdir/.worktree-port" ]] && port=$(<"$wtdir/.worktree-port")
  dirty=$(_wt_dirty "$wtdir")
  if [[ "$wtdir" == "$trunk" ]]; then
    mark="*"
    env=trunk
  else
    _wt_env_summary "$wtdir"
    env="$REPLY"
    _wt_envrc_state "$wtdir"
    [[ "$REPLY" == blocked ]] && env+=" envrc:blocked"
    if [[ "$wtdir" != "$root" && "$wtdir" != "$root"/* ]]; then
      extra="  ⚠ off-book"
    fi
  fi
  printf '%s %-26s %-20s %5s %4s  %s%s\n' "$mark" "$label" "$branch" "$port" "$dirty" "$env" "$extra"
}

_wt_wls_json() {
  local wtdir="${1:A}" branch="$2" head="$3" fl="$4" trunk="$5" root="$6"
  local port="" dirty env="trunk" envrc="" is_trunk=false off=false files="" i sep=""
  local -a pairs
  [[ -f "$wtdir/.worktree-port" ]] && port=$(<"$wtdir/.worktree-port")
  dirty=$(_wt_dirty "$wtdir")
  [[ "$dirty" == "?" ]] && dirty=null
  if [[ "$wtdir" == "$trunk" ]]; then
    is_trunk=true
  else
    _wt_env_summary "$wtdir"
    env="$REPLY"
    pairs=("${reply[@]}")
    _wt_envrc_state "$wtdir"
    envrc="$REPLY"
    [[ "$wtdir" != "$root" && "$wtdir" != "$root"/* ]] && off=true
  fi
  _wt_js "$wtdir"; print -rn -- "{\"path\":$REPLY,"
  _wt_js "${wtdir:t}"; print -rn -- "\"name\":$REPLY,"
  _wt_js "$branch"; print -rn -- "\"branch\":$REPLY,"
  _wt_js "$head"; print -rn -- "\"head\":$REPLY,"
  _wt_js "${fl# }"; print -rn -- "\"flags\":$REPLY,\"trunk\":$is_trunk,\"offBook\":$off,"
  _wt_js "$port"; print -rn -- "\"port\":$REPLY,\"dirty\":$dirty,"
  _wt_js "$env"; print -rn -- "\"env\":$REPLY,"
  _wt_js "$envrc"; print -rn -- "\"envrc\":$REPLY,\"files\":["
  for (( i = 1; i < ${#pairs}; i += 2 )); do
    _wt_js "$pairs[i]"; print -rn -- "$sep{\"file\":$REPLY,"
    _wt_js "$pairs[i+1]"; print -rn -- "\"state\":$REPLY}"
    sep=","
  done
  print -rn -- "]}"
}

# wgo <name> : cd into $ROOT/$PREFIX<name>
wgo() {
  _wt_conf || return 1
  [[ -z "$1" ]] && { echo "usage: wgo <name>"; return 1; }
  local dir="$ROOT/$PREFIX$1"
  if cd "$dir" 2>/dev/null; then
    _wt_banner "$dir"
  else
    echo "no worktree: $PREFIX$1 (try: wls)"
    return 1
  fi
}

# wtrunk : jump to the trunk
wtrunk() {
  _wt_conf || return 1
  cd "$TRUNK"
}

# wenv                     relink this worktree's env: entries already links, or missing
# wenv --status            each entry's state here
# wenv --detach <f>        keep a real copy of <f> here; no relink touches it
# wenv --link <f> [--force]  back to the trunk's file (--force discards a differing copy)
# wenv --link-all [--dry-run]  migrate every worktree: identical copies become links
# wenv --to-trunk [<dir>]  seed the trunk from a checkout that already runs
wenv() {
  _wt_conf || return 1
  local cur
  case "$1" in
    --to-trunk) _wt_env_to_trunk "${2:-$PWD}" "$2"; return $? ;;
    --link-all) _wt_env_link_all "$2"; return $? ;;
  esac
  cur=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "wenv: not in a git worktree"; return 1; }
  if [[ "${cur:A}" == "${TRUNK:A}" ]]; then
    echo "wenv: this IS the trunk — edit env here, every linked worktree sees it"
    return 0
  fi
  case "$1" in
    "") _wt_env_relink "$cur" ;;
    --status) _wt_env_status "$cur" ;;
    --detach) _wt_env_detach "$cur" "$2" ;;
    --link) _wt_env_link "$cur" "$2" "$3" ;;
    *) echo "usage: wenv [--status | --detach <f> | --link <f> [--force] | --link-all [--dry-run] | --to-trunk [<dir>]]"; return 1 ;;
  esac
}

# Plain `wenv`: never converts a real file — that is --link-all's job, asked for.
_wt_env_relink() {
  local dir="$1" f rc=0
  _wt_env_list
  for f in "${reply[@]}"; do
    _wt_env_refused "$f" "$dir"
    if [[ -n "$REPLY" ]]; then
      [[ -e "$TRUNK/$f" || -e "$dir/$f" || -L "$dir/$f" ]] && echo "  refused: $f — $REPLY"
      continue
    fi
    _wt_env_state "$f" "$dir"
    case "$REPLY" in
      linked) echo "  linked $f" ;;
      missing) _wt_link_one "$f" "$dir" && echo "  linked $f" || rc=1 ;;
      broken)
        if [[ -f "$TRUNK/$f" ]]; then
          _wt_link_one "$f" "$dir" && echo "  relinked $f" || rc=1
        else
          echo "  broken: $f — the trunk has none"
        fi
        ;;
      detached) echo "  detached $f — kept (wenv --link $f to share the trunk's)" ;;
      copy) echo "  copy $f — a real file, same as trunk (wenv --link $f, or wenv --link-all)" ;;
      stale) echo "  stale-or-override $f — differs from trunk (wenv --link --force $f, or wenv --detach $f)" ;;
      foreign) echo "  foreign $f — links elsewhere (wenv --link --force $f)" ;;
      other) echo "  other $f — not a file, left alone" ;;
      absent) [[ "$f" == */* ]] && echo "  MISSING in trunk: $f" ;;
    esac
  done
  return $rc
}

_wt_env_status() {
  local dir="$1" f s
  _wt_env_list
  for f in "${reply[@]}"; do
    _wt_env_refused "$f" "$dir"
    if [[ -n "$REPLY" ]]; then
      s="refused ($REPLY)"
    else
      _wt_env_state "$f" "$dir"
      s="$REPLY"
    fi
    printf '  %-32s %s\n' "$f" "$s"
  done
  _wt_envrc_state "$dir"
  [[ -n "$REPLY" ]] && printf '  %-32s %s\n' ".envrc (direnv)" "$REPLY"
  return 0
}

# Only a configured entry may be detached or linked — never an arbitrary path.
_wt_env_entry() {
  local f
  _wt_env_list
  for f in "${reply[@]}"; do [[ "$f" == "$1" ]] && return 0; done
  echo "wenv: $1 is not in ENV_FILES"
  return 1
}

_wt_env_detach() {
  local dir="$1" f="$2"
  [[ -n "$f" ]] || { echo "usage: wenv --detach <file>"; return 1; }
  _wt_env_entry "$f" || return 1
  _wt_env_refused "$f" "$dir"
  [[ -n "$REPLY" ]] && { echo "  refused: $f — $REPLY"; return 1; }
  _wt_env_state "$f" "$dir"
  case "$REPLY" in
    linked|missing|broken)
      [[ -f "$TRUNK/$f" ]] || { echo "wenv: the trunk has no $f to copy"; return 1; }
      mkdir -p "${dir}/${f:h}"
      _wt_copy_one "$f" "$dir" || { echo "wenv: could not copy $f"; return 1; }
      ;;
    copy|stale|detached) ;;
    foreign) echo "wenv: $f links outside the trunk — remove it first"; return 1 ;;
    absent) echo "wenv: neither this worktree nor the trunk has $f"; return 1 ;;
    *) echo "wenv: $f is not a file"; return 1 ;;
  esac
  _wt_detached_has "$f" "$dir" || echo "$f" >> "$dir/.worktree-detached"
  _wt_exclude "$dir" .worktree-detached
  echo "  detached $f — a real copy here; relinks leave it alone (wenv --link $f to undo)"
}

_wt_env_undetach() {
  local list="$2/.worktree-detached" rest
  [[ -f "$list" ]] || return 0
  rest=$(grep -vxF -- "$1" "$list")
  if [[ -z "$rest" ]]; then
    rm -f -- "$list"
  else
    print -r -- "$rest" > "$list"
  fi
}

_wt_env_link() {
  local dir="$1" f="$2" force="$3"
  # Either order: `--link --force <f>` reads as naturally as `--link <f> --force`.
  [[ "$f" == --force ]] && { f="$3"; force="$2"; }
  [[ -n "$f" ]] || { echo "usage: wenv --link <file> [--force]"; return 1; }
  [[ -z "$force" || "$force" == --force ]] || { echo "usage: wenv --link <file> [--force]"; return 1; }
  _wt_env_entry "$f" || return 1
  _wt_env_refused "$f" "$dir"
  [[ -n "$REPLY" ]] && { echo "  refused: $f — $REPLY"; return 1; }
  [[ -f "$TRUNK/$f" ]] || { echo "wenv: the trunk has no $f — seed it: wenv --to-trunk"; return 1; }
  _wt_env_state "$f" "$dir"
  case "$REPLY" in
    linked) ;;
    missing|broken|copy) _wt_link_one "$f" "$dir" || return 1 ;;
    detached|stale|foreign)
      if [[ "$REPLY" == detached ]] && cmp -s -- "$TRUNK/$f" "$dir/$f"; then
        :
      elif [[ -z "$force" ]]; then
        echo "  refused: $f differs from trunk — keep it (wenv --detach $f), or discard it (wenv --link --force $f)"
        return 1
      fi
      _wt_link_one "$f" "$dir" || return 1
      ;;
    *) echo "wenv: $f is not a file"; return 1 ;;
  esac
  _wt_env_undetach "$f" "$dir"
  echo "  linked $f"
}

# Migration, and only on request: every worktree but the trunk. A copy
# identical to trunk becomes a link; everything else is listed with the
# command that resolves it, because a differing file may be an override.
_wt_env_link_all() {
  local dry="$1" i dir label f rc=0 verb=converted
  [[ -z "$dry" || "$dry" == --dry-run ]] || { echo "usage: wenv --link-all [--dry-run]"; return 1; }
  [[ -n "$dry" ]] && verb="would convert"
  _wt_list || { echo "wenv: git worktree list failed in $TRUNK"; return 1; }
  for (( i = 1; i <= ${#_wt_p}; i++ )); do
    dir="${_wt_p[i]:A}"
    [[ "$dir" == "${TRUNK:A}" ]] && continue
    [[ " ${_wt_fl[i]} " == *" bare "* ]] && continue
    label="${dir:t}"
    if [[ ! -d "$dir" ]]; then
      echo "  missing-worktree: $label (git worktree prune)"
      continue
    fi
    _wt_env_list
    for f in "${reply[@]}"; do
      _wt_env_refused "$f" "$dir"
      if [[ -n "$REPLY" ]]; then
        [[ -e "$TRUNK/$f" || -e "$dir/$f" || -L "$dir/$f" ]] && echo "  refused: $label $f — $REPLY"
        continue
      fi
      _wt_env_state "$f" "$dir"
      case "$REPLY" in
        copy)
          if [[ -n "$dry" ]]; then
            echo "  $verb: $label $f"
          elif _wt_link_one "$f" "$dir"; then
            echo "  $verb: $label $f"
          else
            echo "  FAILED to convert: $label $f"; rc=1
          fi
          ;;
        stale) echo "  stale-or-override: $label $f  -> cd $dir && wenv --link --force $f   (or keep it: wenv --detach $f)" ;;
        detached) echo "  detached: $label $f (kept)" ;;
        missing) echo "  missing: $label $f  -> cd $dir && wenv" ;;
        broken) echo "  broken: $label $f  -> cd $dir && wenv" ;;
        foreign) echo "  foreign: $label $f  -> cd $dir && wenv --link --force $f" ;;
        other) echo "  unsupported: $label $f (not a file)" ;;
      esac
    done
    _wt_env_summary "$dir"
    echo "$label: $REPLY"
  done
  return $rc
}

# Seed the trunk from checkout $1. A source that already IS the trunk's file
# (a link) is skipped; a failed copy fails the command; each change is named.
_wt_env_to_trunk() {
  local src f s t tmp rc=0
  src=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || { echo "wenv: ${2:-$1} is not a worktree"; return 1; }
  [[ "${src:A}" == "${TRUNK:A}" ]] && { echo "wenv: that IS the trunk"; return 1; }
  _wt_env_list
  for f in "${reply[@]}"; do
    _wt_env_bad_path "$f" "$src"
    [[ -n "$REPLY" ]] && { echo "  refused: $f — $REPLY"; continue; }
    s="$src/$f" t="$TRUNK/$f"
    [[ -f "$s" ]] || continue
    _wt_env_bad_path "$f" "$TRUNK"
    [[ -n "$REPLY" ]] || { _wt_env_bad_git "$f" "$TRUNK"; [[ -n "$REPLY" ]] && REPLY="in the trunk: $REPLY"; }
    [[ -n "$REPLY" ]] && { echo "  refused: $f — $REPLY"; continue; }
    if [[ -e "$t" && "$s" -ef "$t" ]]; then
      echo "  already the trunk's: $f"
      continue
    fi
    if [[ -L "$t" ]]; then
      echo "  refused: $f — the trunk's is a link; update what it points to"
      rc=1
      continue
    fi
    if [[ -f "$t" ]] && cmp -s -- "$s" "$t"; then
      echo "  unchanged $f"
      continue
    fi
    tmp="${t:h}/.${t:t}.wt-seed.$$"
    if mkdir -p "${t:h}" 2>/dev/null && cp -p -- "$s" "$tmp" 2>/dev/null && mv -f -- "$tmp" "$t" 2>/dev/null; then
      echo "  seeded $f (the trunk's changed — every linked worktree sees it)"
    else
      rm -f -- "$tmp" 2>/dev/null
      echo "  FAILED to seed $f"
      rc=1
    fi
  done
  return $rc
}

# wdev : run the dev server on this worktree's claimed port
wdev() {
  _wt_conf || return 1
  local dir port cmd
  dir=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "wdev: not in a git worktree"; return 1; }
  if [[ ! -f "$dir/.worktree-port" ]]; then
    echo "wdev: no port assigned"
    return 1
  fi
  port=$(<"$dir/.worktree-port")
  echo "wdev: -> http://localhost:$port"
  cmd="${WT_DEV_CMD:-npm run dev}"
  cd "$dir" || return 1
  PORT="$port" eval exec "$cmd"
}

# ---- Cleanup: remove only what is provably finished -----------------------
# A worktree is done when the exact commit it sits on is in BASE — as an
# ancestor, or as the head of a merged PR from this repo into BASE's branch
# (a squash merge leaves no ancestor) — its tree is clean, and no env entry
# holds data the trunk does not. A check that cannot run makes it unknown,
# never done.

# gh's JSON, parsed here so the toolkit needs nothing beyond zsh and git.
# reply = one "number<TAB>headRefOid<TAB>owner login<TAB>baseRefName" per PR.
# Returns 1 on anything it does not understand; the caller treats that as gh
# failing, never as "no PRs".
_wt_prs_parse() {
  setopt local_options no_multibyte
  local _j_s="$1" _j_path=""
  local -i _j_i=1 _j_n=${#1}
  local -A _j_rec
  reply=()
  _wt_j_ws
  [[ "${_j_s[_j_i]}" == "[" ]] || return 1
  (( _j_i++ ))
  _wt_j_ws
  if [[ "${_j_s[_j_i]}" == "]" ]]; then
    (( _j_i++ ))
  else
    while true; do
      _j_rec=()
      _wt_j_val || return 1
      reply+=("${_j_rec[.number]}"$'\t'"${_j_rec[.headRefOid]}"$'\t'"${_j_rec[.headRepositoryOwner.login]}"$'\t'"${_j_rec[.baseRefName]}")
      _wt_j_ws
      case "${_j_s[_j_i]}" in
        ,) (( _j_i++ )) ;;
        "]") (( _j_i++ )); break ;;
        *) return 1 ;;
      esac
    done
  fi
  _wt_j_ws
  (( _j_i > _j_n ))
}
_wt_j_ws() {
  while (( _j_i <= _j_n )) && [[ "${_j_s[_j_i]}" == [[:space:]] ]]; do (( _j_i++ )); done
}
# A string at _j_i into REPLY. \u escapes become "?", so a value carrying one
# can never equal a sha, login or branch it is compared with.
_wt_j_str() {
  local out="" c
  [[ "${_j_s[_j_i]}" == '"' ]] || return 1
  (( _j_i++ ))
  while (( _j_i <= _j_n )); do
    c="${_j_s[_j_i]}"
    if [[ "$c" == '"' ]]; then
      (( _j_i++ ))
      REPLY="$out"
      return 0
    fi
    if [[ "$c" == '\' ]]; then
      (( _j_i++ ))
      c="${_j_s[_j_i]}"
      case "$c" in
        '"'|'\'|/) out+="$c" ;;
        n) out+=$'\n' ;;
        t) out+=$'\t' ;;
        r) out+=$'\r' ;;
        b|f) out+="?" ;;
        u) out+="?"; (( _j_i += 4 )) ;;
        *) return 1 ;;
      esac
    else
      out+="$c"
    fi
    (( _j_i++ ))
  done
  return 1
}
# Any value at _j_i. A scalar is recorded in _j_rec under its key path
# (.number, .headRepositoryOwner.login, ...); containers recurse.
_wt_j_val() {
  local c start key saved="$_j_path"
  _wt_j_ws
  c="${_j_s[_j_i]}"
  case "$c" in
    '"')
      _wt_j_str || return 1
      [[ -n "$_j_path" ]] && _j_rec[$_j_path]="$REPLY"
      ;;
    "{")
      (( _j_i++ ))
      _wt_j_ws
      if [[ "${_j_s[_j_i]}" == "}" ]]; then (( _j_i++ )); return 0; fi
      while true; do
        _wt_j_ws
        _wt_j_str || return 1
        key="$REPLY"
        _wt_j_ws
        [[ "${_j_s[_j_i]}" == : ]] || return 1
        (( _j_i++ ))
        _j_path="$saved.$key"
        _wt_j_val || return 1
        _j_path="$saved"
        _wt_j_ws
        case "${_j_s[_j_i]}" in
          ,) (( _j_i++ )) ;;
          "}") (( _j_i++ )); return 0 ;;
          *) return 1 ;;
        esac
      done
      ;;
    "[")
      (( _j_i++ ))
      _wt_j_ws
      if [[ "${_j_s[_j_i]}" == "]" ]]; then (( _j_i++ )); return 0; fi
      while true; do
        _j_path="$saved[]"
        _wt_j_val || return 1
        _j_path="$saved"
        _wt_j_ws
        case "${_j_s[_j_i]}" in
          ,) (( _j_i++ )) ;;
          "]") (( _j_i++ )); return 0 ;;
          *) return 1 ;;
        esac
      done
      ;;
    *)
      start=$_j_i
      while (( _j_i <= _j_n )) && [[ "${_j_s[_j_i]}" == [-+.0-9a-zA-Z] ]]; do (( _j_i++ )); done
      (( _j_i > start )) || return 1
      [[ -n "$_j_path" ]] && _j_rec[$_j_path]="${_j_s[start,_j_i-1]}"
      ;;
  esac
  return 0
}

# origin as GitHub sees it: _wt_gh_repo (for --repo) and _wt_gh_owner, or
# REPLY = why there is none. Read from the configured URL, not `remote
# get-url`, which applies insteadOf rewrites.
_wt_gh_origin() {
  local url host rest
  _wt_gh_repo="" _wt_gh_owner=""
  REPLY=""
  url=$(git -C "$TRUNK" config --get remote.origin.url 2>/dev/null) || { REPLY="no origin remote"; return 1; }
  case "$url" in
    https://*|http://*|ssh://*|git://*)
      rest="${url#*://}"
      rest="${rest#*@}"
      host="${rest%%/*}"
      host="${host%%:*}"
      rest="${rest#*/}"
      ;;
    *@*:*)
      rest="${url#*@}"
      host="${rest%%:*}"
      rest="${rest#*:}"
      ;;
    *) REPLY="origin is not a GitHub URL"; return 1 ;;
  esac
  rest="${rest%.git}"
  rest="${rest%/}"
  if [[ ! "$rest" =~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' ]]; then
    REPLY="origin is not a GitHub URL"
    return 1
  fi
  _wt_gh_owner="${rest%%/*}"
  if [[ "$host" == github.com ]]; then _wt_gh_repo="$rest"; else _wt_gh_repo="$host/$rest"; fi
  return 0
}

# BASE as the branch a PR targets: origin/main -> main.
_wt_base_branch() {
  local remote="${BASE%%/*}"
  if [[ "$BASE" == */* ]] && git -C "$TRUNK" rev-parse --verify --quiet "refs/remotes/$BASE" >/dev/null 2>&1; then
    REPLY="${BASE#$remote/}"
  else
    REPLY="$BASE"
  fi
}

# The verdict on one worktree, into V_status (done | not-done | unknown),
# V_reason, V_via, V_head and V_oid (the merged PR head, when that is the proof).
# $1 path, $2 branch, $3 flags. Needs _wt_primary, _wt_bbranch and the gh state
# set by wclean.
_wt_verdict() {
  local p="${1:A}" b="$2" fl="$3" here="${PWD:A}" out gd op h cur rc f line
  local -a prs
  local num oid owner base match="" after="" behind="" absent="" older="" fork="" wrong="" wrong_base="" n
  V_status=not-done V_reason="" V_via="" V_head="" V_oid="" V_pr=""
  if [[ "$p" == "${TRUNK:A}" ]]; then V_reason="trunk"; return 0; fi
  if [[ "$p" == "$_wt_primary" ]]; then V_reason="primary checkout"; return 0; fi
  if [[ "$here" == "$p" || "$here" == "$p"/* ]]; then V_reason="you are inside it"; return 0; fi
  if [[ " $fl " == *" bare "* ]]; then V_reason="bare"; return 0; fi
  if [[ " $fl " == *" locked "* ]]; then V_reason="locked"; return 0; fi
  if [[ " $fl " == *" prunable "* || ! -d "$p" ]]; then V_reason="directory missing (git worktree prune)"; return 0; fi
  gd=$(git -C "$p" rev-parse --path-format=absolute --git-dir 2>&1) || {
    V_status=unknown V_reason="unknown — not removable: ${gd%%$'\n'*}"; return 0; }
  for op in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG; do
    if [[ -e "$gd/$op" ]]; then
      case "$op" in
        rebase-*) V_reason="rebase in progress" ;;
        MERGE_HEAD) V_reason="merge in progress" ;;
        CHERRY_PICK_HEAD) V_reason="cherry-pick in progress" ;;
        REVERT_HEAD) V_reason="revert in progress" ;;
        BISECT_LOG) V_reason="bisect in progress" ;;
      esac
      return 0
    fi
  done
  if [[ " $fl " == *" detached "* || -z "$b" ]]; then V_reason="detached HEAD"; return 0; fi
  h=$(git -C "$p" rev-parse --verify --quiet HEAD 2>&1) || {
    V_status=unknown V_reason="unknown — not removable: cannot read HEAD"; return 0; }
  V_head="$h"
  cur=$(git -C "$p" symbolic-ref --quiet --short HEAD 2>/dev/null)
  if [[ "$cur" != "$b" ]]; then
    V_status=unknown V_reason="unknown — not removable: branch changed to ${cur:-detached}"; return 0
  fi
  if [[ -e "$p/.gitmodules" ]]; then V_reason="contains submodules"; return 0; fi
  out=$(git -C "$p" ls-files --stage 2>&1) || {
    V_status=unknown V_reason="unknown — not removable: git ls-files failed"; return 0; }
  if [[ "$out" == 160000\ * || "$out" == *$'\n'160000\ * ]]; then V_reason="contains submodules"; return 0; fi

  # 2. Merged, exactly.
  git -C "$TRUNK" merge-base --is-ancestor "$h" "$BASE" 2>/dev/null
  rc=$?
  if (( rc == 0 )); then
    V_via="in $BASE"
  elif (( rc != 1 )); then
    V_status=unknown V_reason="unknown — not removable: git merge-base failed"; return 0
  elif [[ -n "$_wt_gh_why" ]]; then
    V_reason="not in $BASE (ancestor check only: $_wt_gh_why)"; return 0
  else
    out=$(unset GH_REPO GH_HOST; GH_PROMPT_DISABLED=1 gh pr list --repo "$_wt_gh_repo" --state merged --head "$b" \
      --json number,headRefOid,headRepositoryOwner,baseRefName,mergedAt --limit 50 2>&1)
    rc=$?
    if (( rc != 0 )) || ! _wt_prs_parse "$out"; then
      (( rc != 0 )) && _wt_gh_fail="gh failed: ${out%%$'\n'*}" || _wt_gh_fail="gh output not understood"
      V_reason="not in $BASE (ancestor check only: $_wt_gh_fail)"; return 0
    fi
    prs=("${reply[@]}")
    for line in "${prs[@]}"; do
      IFS=$'\t' read -r num oid owner base <<< "$line"
      if [[ "${(L)owner}" != "${(L)_wt_gh_owner}" ]]; then
        fork="${fork:-$num}"
      elif [[ "$base" != "$_wt_bbranch" ]]; then
        wrong="${wrong:-$num}" wrong_base="${wrong_base:-$base}"
      elif [[ "$oid" == "$h" ]]; then
        match="$num" V_oid="$oid"
        break
      elif [[ -z "$oid" ]] || ! git -C "$p" cat-file -e "$oid^{commit}" 2>/dev/null; then
        absent="${absent:-$num}"
      elif git -C "$p" merge-base --is-ancestor "$oid" "$h" 2>/dev/null; then
        after="${after:-$num}"
        [[ -z "$n" ]] && n=$(git -C "$p" rev-list --count "$oid..$h" 2>/dev/null)
      elif git -C "$p" merge-base --is-ancestor "$h" "$oid" 2>/dev/null; then
        behind="${behind:-$num}"
      else
        older="${older:-$num}"
      fi
    done
    if [[ -n "$match" ]]; then
      V_via="merged PR #$match" V_pr="$match"
    elif [[ -n "$after" ]]; then
      V_reason="${n:-some} commit$([[ "$n" == 1 ]] || echo s) after merged PR #$after"; return 0
    elif [[ -n "$behind" ]]; then
      V_reason="behind merged PR #$behind — its head has commits this checkout lacks (pull, then re-check)"; return 0
    elif [[ -n "$absent" ]]; then
      V_reason="merged PR #$absent's head is not in this checkout (fetch, then re-check)"; return 0
    elif [[ -n "$older" ]]; then
      V_reason="merged PR #$older was for a different commit of $b"; return 0
    elif [[ -n "$wrong" ]]; then
      V_reason="merged PR #$wrong went into $wrong_base, not $_wt_bbranch"; return 0
    elif [[ -n "$fork" ]]; then
      V_reason="merged PR #$fork came from another fork"; return 0
    else
      V_reason="not merged"; return 0
    fi
  fi

  # 3. Clean.
  out=$(git -C "$p" status --porcelain=v1 -z --untracked-files=all --ignore-submodules=none 2>/dev/null) || {
    V_status=unknown V_reason="unknown — not removable: git status failed"; return 0; }
  if [[ -n "$out" ]]; then
    local -a ents
    ents=(${(0)out})
    ents=(${(M)ents:#[ MADRCUT?!][ MADRCUT?!] *})
    if [[ -z "${ents:#\?\? *}" ]]; then
      V_reason="${#ents} untracked file$( (( ${#ents} == 1 )) || echo s)"
    else
      V_reason="uncommitted changes (${#ents})"
    fi
    V_via=""
    return 0
  fi

  # 4. No env data the trunk lacks.
  _wt_env_list
  for f in "${reply[@]}"; do
    _wt_env_bad_path "$f" "$p"
    [[ -n "$REPLY" ]] && continue
    _wt_env_state "$f" "$p"
    case "$REPLY" in
      detached) V_reason="detached $f — wenv --to-trunk or delete it first" ;;
      stale) V_reason="$f differs from trunk — wenv --to-trunk or delete it first" ;;
      foreign) V_reason="$f links outside the trunk" ;;
      other) V_reason="$f is not a file" ;;
    esac
    if [[ -n "$V_reason" ]]; then V_via=""; return 0; fi
  done
  V_status=done
  return 0
}

# wclean [--json] [--no-fetch] : every worktree, done or why not
# wclean --remove [--no-fetch] : ask once, then remove the done ones
wclean() {
  _wt_conf || return 1
  setopt local_options local_traps
  local remove=0 json=0 fetch=1 a i sep="" common lock rc=0 ans label out verdict
  local -a notes done_i done_h done_oid done_via
  for a in "$@"; do
    case "$a" in
      --remove) remove=1 ;;
      --json) json=1 ;;
      --no-fetch) fetch=0 ;;
      *) echo "usage: wclean [--remove] [--json] [--no-fetch]"; return 1 ;;
    esac
  done
  (( remove && json )) && { echo "wclean: --remove is interactive; it takes no --json"; return 1; }
  common=$(git -C "$TRUNK" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || {
    echo "wclean: $TRUNK is not a git checkout"; return 1; }

  # One remover at a time per project; a lock left by a dead process is taken over.
  if (( remove )); then
    lock="$common/wt-clean.lock"
    if ! mkdir "$lock" 2>/dev/null; then
      local holder
      holder=$(<"$lock/pid" 2>/dev/null)
      if [[ -n "$holder" ]] && ! kill -0 "$holder" 2>/dev/null; then
        rm -rf -- "$lock"
        mkdir "$lock" 2>/dev/null || { echo "wclean: another wclean --remove is running for this project (lock: $lock)"; return 1; }
      else
        echo "wclean: another wclean --remove is running for this project (lock: $lock)"
        return 1
      fi
    fi
    echo $$ > "$lock/pid"
    trap "rm -rf -- ${(q)lock}" EXIT INT TERM
  fi

  if (( fetch )); then
    _wt_fetch 2>/dev/null || notes+=("fetch failed — merge status is against a local $BASE")
  else
    notes+=("not fetched — merge status is against the local $BASE")
  fi
  typeset -g _wt_gh_repo _wt_gh_owner _wt_gh_why="" _wt_gh_fail="" _wt_bbranch _wt_primary
  if (( ! $+commands[gh] )); then
    _wt_gh_why="gh not installed"
  elif ! _wt_gh_origin; then
    _wt_gh_why="$REPLY"
  fi
  _wt_base_branch
  _wt_bbranch="$REPLY"
  _wt_list || { echo "wclean: git worktree list failed in $TRUNK"; return 1; }
  _wt_primary="${_wt_p[1]:A}"

  (( json )) && print -rn -- "{"
  (( json )) || echo "Worktrees of ${TRUNK:t} against $BASE:"
  local -a rows
  local row
  for (( i = 1; i <= ${#_wt_p}; i++ )); do
    _wt_verdict "$_wt_p[i]" "$_wt_b[i]" "$_wt_fl[i]"
    label="${_wt_p[i]:t}"
    [[ -n "$PREFIX" && "$label" == "$PREFIX"?* ]] && label="${label#$PREFIX}"
    if (( json )); then
      _wt_js "${_wt_p[i]:A}"; row="{\"path\":$REPLY,"
      _wt_js "$label"; row+="\"name\":$REPLY,"
      _wt_js "$_wt_b[i]"; row+="\"branch\":$REPLY,"
      _wt_js "${V_head:-$_wt_h[i]}"; row+="\"head\":$REPLY,"
      _wt_js "$V_status"; row+="\"status\":$REPLY,"
      _wt_js "${V_reason:-done}"; row+="\"reason\":$REPLY,"
      _wt_js "$V_via"; row+="\"via\":$REPLY}"
      rows+=("$row")
    else
      if [[ "$V_status" == done ]]; then verdict="done ($V_via)"; else verdict="$V_reason"; fi
      printf '  %-26s %-24s %s\n' "$label" "[${_wt_b[i]:-detached}]" "$verdict"
    fi
    if [[ "$V_status" == done ]]; then
      done_i+=("$i") done_h+=("$V_head") done_oid+=("$V_oid") done_via+=("$V_via")
    fi
  done
  [[ -n "$_wt_gh_why" ]] && notes+=("$_wt_gh_why — squash merges are not detected, only ancestors of $BASE")
  [[ -n "$_wt_gh_fail" ]] && notes+=("$_wt_gh_fail — only ancestors of $BASE were checked")
  if (( json )); then
    _wt_js "$BASE"; print -rn -- "\"base\":$REPLY,\"notes\":["
    for a in "${notes[@]}"; do _wt_js "$a"; print -rn -- "$sep$REPLY"; sep=","; done
    print -rn -- "],\"worktrees\":["
    print -rn -- "${(j:,:)rows}"
    print -r -- "]}"
    return 0
  fi
  for a in "${notes[@]}"; do echo "wclean: $a"; done
  if (( ! remove )); then
    (( ${#done_i} )) && echo "done: ${#done_i} — remove them:  wclean --remove"
    return 0
  fi
  if (( ! ${#done_i} )); then
    echo "nothing to remove"
    return 0
  fi
  printf 'Remove %d done worktree%s and their branches? [y/N] ' ${#done_i} "$( (( ${#done_i} == 1 )) || echo s)"
  read -r ans
  if [[ "$ans" != [yY] ]]; then
    echo "nothing removed"
    return 0
  fi

  # Everything is checked again right before its removal: the prompt may have
  # waited long enough for a commit, an edit or a new env file.
  local j k p b tip
  for (( j = 1; j <= ${#done_i}; j++ )); do
    i=$done_i[j]
    p="${_wt_p[i]:A}" b="$_wt_b[i]" label="${p:t}"
    [[ -n "$PREFIX" && "$label" == "$PREFIX"?* ]] && label="${label#$PREFIX}"
    _wt_list || { echo "wclean: git worktree list failed — stopping"; return 1; }
    for (( k = 1; k <= ${#_wt_p}; k++ )); do [[ "${_wt_p[k]:A}" == "$p" ]] && break; done
    if (( k > ${#_wt_p} )) || [[ "$_wt_b[k]" != "$b" ]]; then
      echo "  skipped $label — no longer the same worktree"
      continue
    fi
    _wt_verdict "$_wt_p[k]" "$_wt_b[k]" "$_wt_fl[k]"
    if [[ "$V_status" != done || "$V_head" != "$done_h[j]" ]]; then
      echo "  skipped $label — changed since the list: ${V_reason:-HEAD moved}"
      continue
    fi
    if ! out=$(git -C "$TRUNK" worktree remove "$p" 2>&1); then
      echo "  FAILED to remove $label: ${out%%$'\n'*} — branch $b kept"
      rc=1
      continue
    fi
    tip=$(git -C "$TRUNK" rev-parse --verify --quiet "refs/heads/$b" 2>/dev/null)
    if [[ -n "$tip" ]] && { [[ -n "$done_oid[j]" && "$tip" == "$done_oid[j]" ]] ||
        git -C "$TRUNK" merge-base --is-ancestor "$tip" "$BASE" 2>/dev/null; }; then
      if git -C "$TRUNK" branch -D "$b" >/dev/null 2>&1; then
        echo "  removed $label and branch $b"
      else
        echo "  removed $label; could not delete branch $b"
      fi
    else
      echo "  removed $label; kept branch $b — its tip moved"
    fi
  done
  return $rc
}

# wrm <name> [--force] : remove the $PREFIX<name> worktree
wrm() {
  _wt_conf || return 1
  [[ -z "$1" ]] && { echo "usage: wrm <name> [--force]"; return 1; }
  local dir="$ROOT/$PREFIX$1" here="$PWD" st
  # git refuses to remove the worktree you're standing in
  if [[ "${PWD:A}" == "${dir:A}" || "${PWD:A}" == "${dir:A}"/* ]]; then
    cd "$TRUNK" || return 1
  fi
  git -C "$TRUNK" worktree remove "$dir" "${@:2}"
  st=$?
  if (( st != 0 )) && [[ "$here" != "$PWD" ]]; then
    cd "$here" 2>/dev/null
  fi
  return $st
}

# wtinit : configure a NEW project (run from any checkout)
# wtinit --register [--cmd <p>] [--key <name>] : list an ALREADY configured one in repos/
# Read one setting out of the template, with {key}/{parent} expanded. The template
# is the convention; wtinit must not quietly compute its own layout instead.
_wt_tmpl_val() {
  local want="$1" key="$2" parent="$3" tmpl="$WT_HOME/defaults.conf" line
  [[ -f "$tmpl" ]] || return 1
  line=$(grep -m1 "^$want=" "$tmpl") || return 1
  line="${line#$want=}"
  line="${line//\"/}"
  line="${line//\{key\}/$key}"
  line="${line//\{parent\}/$parent}"
  [[ -n "$line" ]] || return 1
  print -r -- "$line"
}

wtinit() {
  local git_common primary key parent conf short why default
  local has_staging=0 has_main=0 has_master=0
  local base_override="" cmd_prefix="" gi
  local key_override="" trunk_override="" root_override="" register=0
  local _wt_init_usage="usage: wtinit [--base <ref>] [--cmd <prefix>] [--key <name>] [--trunk <dir>] [--root <dir>] [--register]"
  while [[ -n "$1" ]]; do
    case "$1" in
      --base) [[ -z "$2" ]] && { echo "$_wt_init_usage"; return 1; }
              base_override="$2"; shift 2 ;;
      --cmd)  [[ -z "$2" ]] && { echo "$_wt_init_usage"; return 1; }
              cmd_prefix="$2"; shift 2 ;;
      --key)  [[ -z "$2" ]] && { echo "$_wt_init_usage"; return 1; }
              key_override="$2"; shift 2 ;;
      --trunk) [[ -z "$2" ]] && { echo "$_wt_init_usage"; return 1; }
              trunk_override="$2"; shift 2 ;;
      --root) [[ -z "$2" ]] && { echo "$_wt_init_usage"; return 1; }
              root_override="$2"; shift 2 ;;
      --register) register=1; shift ;;
      *)      echo "$_wt_init_usage"; return 1 ;;
    esac
  done

  git_common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || {
    echo "wtinit: not in a git repo"
    return 1
  }
  primary="${git_common:h}"
  # The primary worktree is often a working checkout (kylie-main), not the project
  # name — so --key/--trunk/--root exist rather than a cleverer guess.
  parent="${primary:h}"
  key="${key_override:-${(L)primary:t}}"
  conf="$primary/.worktrees.conf"
  if [[ -f "$conf" ]]; then
    cat "$conf"
    echo "wtinit: already configured"
    (( register )) || [[ -n "$cmd_prefix" ]] || return 0
    _wt_source "$conf" || return 1
    _wt_register "$key" "$cmd_prefix" "$TRUNK"
    return $?
  fi
  # An existing config found some other way (the trunk is a linked worktree).
  if (( register )); then
    _wt_conf >/dev/null || { echo "wtinit: --register needs a configured project — run wtinit first"; return 1; }
    _wt_register "$key" "$cmd_prefix" "$TRUNK"
    return $?
  fi
  TRUNK="${trunk_override:-$(_wt_tmpl_val TRUNK "$key" "$parent")}"
  ROOT="${root_override:-$(_wt_tmpl_val ROOT "$key" "$parent")}"
  PREFIX="$(_wt_tmpl_val PREFIX "$key" "$parent")"
  [[ -n "$TRUNK" ]]  || TRUNK="$parent/$key-trunk"
  [[ -n "$ROOT" ]]   || ROOT="$parent/$key-wt"
  [[ -n "$PREFIX" ]] || PREFIX="$key-"

  if [[ -f "$TRUNK/.worktrees.conf" ]]; then
    cat "$TRUNK/.worktrees.conf"
    echo "wtinit: already configured"
    (( register )) || [[ -n "$cmd_prefix" ]] || return 0
    _wt_source "$TRUNK/.worktrees.conf" || return 1
    _wt_register "$key" "$cmd_prefix" "$TRUNK"
    return $?
  fi

  echo "key      $key"
  echo "TRUNK    $TRUNK"
  echo "ROOT     $ROOT"
  echo "PREFIX   $PREFIX"

  git -C "$primary" rev-parse --verify --quiet origin/staging >/dev/null && has_staging=1
  git -C "$primary" rev-parse --verify --quiet origin/main >/dev/null && has_main=1
  git -C "$primary" rev-parse --verify --quiet origin/master >/dev/null && has_master=1
  default=$(git -C "$primary" symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null) || default=""
  default="${default#refs/remotes/}"

  if [[ -n "$base_override" ]]; then
    BASE="$base_override"
    why="from --base"
  elif (( has_staging )) && [[ -n "$default" && "$default" != origin/main && "$default" != origin/master ]]; then
    BASE=origin/staging
    why="origin/HEAD is $default"
  elif (( has_main )); then
    BASE=origin/main
    why="preferred origin/main"
  elif (( has_master )); then
    BASE=origin/master
    why="origin/main not found"
  elif (( has_staging )); then
    BASE=origin/staging
    why="no origin/main or origin/master"
  else
    BASE=$(git -C "$primary" branch --show-current)
    [[ -z "$BASE" ]] && BASE=HEAD
    why="no origin/main, origin/master, or origin/staging"
  fi
  echo "BASE     $BASE  ($why)"

  if [[ ! -d "$TRUNK" ]]; then
    git -C "$primary" worktree add "$TRUNK" --detach "$BASE" || return 1
    short="${BASE##*/}"
    # original checkout is often already on this branch; git otherwise refuses
    git -C "$TRUNK" checkout --ignore-other-worktrees -B "$short" "$BASE" || return 1
    echo "wtinit: created trunk $TRUNK on $short (from $BASE)"
  else
    echo "wtinit: trunk already exists: $TRUNK"
  fi
  mkdir -p "$ROOT"

  # The template is the convention; this function only fills in the repo.
  # A missing template still produces a working config, just an unopinionated one.
  local tmpl="$WT_HOME/defaults.conf"
  if [[ -f "$tmpl" ]]; then
    echo "# Worktree rules for $key. Seeded from $tmpl; edit here, not there." \
      > "$TRUNK/.worktrees.conf"
    # Drop the template's own preamble — it documents the template, not this repo.
    # Per-key comments below it are worth keeping.
    # Substitute only on assignment lines; the comments explain the template and
    # read as nonsense with real paths spliced into them.
    sed -e '1,/^$/d' \
        -e "/^[A-Za-z_][A-Za-z_]*=/s|{key}|$key|g" \
        -e "/^[A-Za-z_][A-Za-z_]*=/s|{parent}|$parent|g" \
        -e "s|^TRUNK=.*|TRUNK=\"$TRUNK\"|" \
        -e "s|^ROOT=.*|ROOT=\"$ROOT\"|" \
        -e "s|^PREFIX=.*|PREFIX=\"$PREFIX\"|" \
        -e "s|^BASE=.*|BASE=\"$BASE\"|" \
        "$tmpl" >> "$TRUNK/.worktrees.conf"
  else
    {
      echo "TRUNK=\"$TRUNK\""
      echo "ROOT=\"$ROOT\""
      echo "PREFIX=\"$PREFIX\""
      echo "BASE=\"$BASE\""
      echo "ENV_FILES=\".env .env.local .env.development .env.development.local .envrc\""
      echo "PORTS="
      echo "POST_CREATE="
    } > "$TRUNK/.worktrees.conf"
  fi

  # info/exclude lives in the common dir, so one write covers every worktree.
  # Appending to a tracked .gitignore would need a commit to reach them at all.
  # Both are machine-local: the conf holds absolute paths for THIS Mac, and the
  # port file is per-worktree. info/exclude is shared by every worktree.
  gi="$git_common/info/exclude"
  mkdir -p "${gi:h}"
  local ig
  for ig in .worktree-port .worktrees.conf .worktree-detached; do
    grep -qxF "$ig" "$gi" 2>/dev/null || echo "$ig" >> "$gi"
  done

  # Every project is registered, so tools that list projects (ACS, wtreg) see
  # it; a command prefix is what makes `<prefix>new` exist in every shell.
  _wt_register "$key" "$cmd_prefix" "$TRUNK"

  cat "$TRUNK/.worktrees.conf"
  if [[ -n "$cmd_prefix" ]]; then
    echo "wtinit: done — now:  ${cmd_prefix}new <name>"
  else
    echo "wtinit: done — now:  wnew <name>   (add a prefix later: wtinit --cmd <p>)"
  fi
}

# repos/<key>.conf records the project; `CMD=` stays empty without a prefix.
# A key already naming another trunk is refused, and re-registering keeps a
# prefix it is not given.
_wt_register() {
  local key="$1" cmd="$2" trunk="$3" f="$WT_HOME/repos/$1.conf" old_trunk old_cmd
  if [[ -f "$f" ]]; then
    old_trunk=$(unset CMD TRUNK; source "$f"; print -r -- "$TRUNK")
    old_cmd=$(unset CMD TRUNK; source "$f"; print -r -- "$CMD")
    if [[ -n "$old_trunk" && "${old_trunk:A}" != "${trunk:A}" ]]; then
      echo "wtinit: repos/$key.conf already registers $old_trunk — pick another --key"
      return 1
    fi
    [[ -z "$cmd" ]] && cmd="$old_cmd"
  fi
  mkdir -p "$WT_HOME/repos"
  {
    echo "CMD=$cmd"
    echo "TRUNK=\"$trunk\""
  } > "$f"
  if [[ -n "$cmd" ]]; then
    _wt_bind "$cmd" "$trunk"
    echo "wtinit: registered ${cmd}new / ${cmd}ls / ${cmd}go / ${cmd}rm / ${cmd}clean / ${cmd}dev / ${cmd}env / ${cmd}trunk"
  else
    echo "wtinit: registered $key (no command prefix — add one: wtinit --register --cmd <p>)"
  fi
}

# ---- Per-project commands -------------------------------------------------
# repos/<key>.conf declares `CMD=k` and `TRUNK=...`; that becomes knew/kls/kgo/
# krm/kclean/kdev/kenv/ktrunk, all pinned to that project from any directory.
# The project's real settings stay in $TRUNK/.worktrees.conf, read on call.
_wt_bind() {
  local cmd="$1" trunk="$2" verb fn
  # The bare name is the anchor: `airflo` drops you in the trunk, the way `kt` does.
  if ! whence -w "$cmd" >/dev/null 2>&1; then
    eval "$cmd() { cd \"$trunk\" && _wt_banner; }"
  elif [[ "$WT_QUIET" != 1 ]]; then
    echo "wt: skipping $cmd — name already taken"
  fi
  for verb in new ls go rm clean dev env trunk; do
    fn="$cmd$verb"
    # Never clobber an existing command — a silent shadow of `ls` or `cd` is worse
    # than an unbound project.
    if (( $+functions[$fn] )) || whence -w "$fn" >/dev/null 2>&1; then
      [[ "$WT_QUIET" == 1 ]] || echo "wt: skipping $fn — name already taken"
      continue
    fi
    eval "$fn() { WT_PIN_TRUNK=\"$trunk\" w$verb \"\$@\"; }"
  done
}

# `wtreg` lists what is registered; run it when you forget a project's prefix.
wtreg() {
  local f
  for f in "$WT_HOME"/repos/*.conf(N); do
    ( source "$f"; printf "%-10s %-8s %s\n" "${f:t:r}" "${CMD:-—}" "$TRUNK" )
  done
}

# Quiet at startup: a name already owned by an alias is expected and reporting it
# on every new shell is noise. `wtinit --cmd` still says so when you register one.
WT_QUIET=1
for _wt_f in "$WT_HOME"/repos/*.conf(N); do
  unset CMD TRUNK
  source "$_wt_f"
  [[ -n "$CMD" && -n "$TRUNK" ]] && _wt_bind "$CMD" "$TRUNK"
done
unset _wt_f CMD TRUNK WT_QUIET
