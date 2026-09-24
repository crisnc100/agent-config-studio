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

_wt_copy_env() {
  local dest="$1" overwrite="${2:-}" f miss=0
  [[ -z "$ENV_FILES" ]] && return 0
  for f in ${=ENV_FILES}; do
    if [[ ! -f "$TRUNK/$f" ]]; then
      # Only a problem if it was named explicitly; the default list is generic.
      [[ "$f" == */* ]] && { echo "  MISSING in trunk: $f"; miss=1; }
      continue
    fi
    [[ -z "$overwrite" && -e "$dest/$f" ]] && continue
    mkdir -p "${dest}/${f:h}"
    cp "$TRUNK/$f" "$dest/$f" && echo "  ${overwrite:+synced }${overwrite:-copied} $f"
  done
  (( miss )) && echo "  -> seed the trunk first:  wenv --to-trunk <source-worktree>"
  return 0
}

_wt_dirty() {
  git -C "$1" status --porcelain 2>/dev/null | wc -l | tr -d ' '
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
  local name="$1" dir="$ROOT/$PREFIX$1" note="" p
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
  _wt_copy_env "$dir"
  [[ -f "$dir/.envrc" ]] && ( cd "$dir" && direnv allow ) 2>/dev/null
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

# wls : every worktree of this repo — branch, port, dirty count; off-book flagged.
wls() {
  _wt_conf || return 1
  local line wtdir branch trunk root
  trunk="${TRUNK:A}"
  root="${ROOT:A}"
  wtdir=""
  branch=""
  while IFS= read -r line; do
    case "$line" in
      worktree\ *)
        [[ -n "$wtdir" ]] && _wt_wls_row "$wtdir" "$branch" "$trunk" "$root"
        wtdir="${line#worktree }"
        branch=""
        ;;
      branch\ *)
        branch="${line#branch }"
        branch="${branch#refs/heads/}"
        ;;
      detached) branch="detached" ;;
      "")
        [[ -n "$wtdir" ]] && _wt_wls_row "$wtdir" "$branch" "$trunk" "$root"
        wtdir=""; branch=""
        ;;
    esac
  done < <(git -C "$TRUNK" worktree list --porcelain)
  [[ -n "$wtdir" ]] && _wt_wls_row "$wtdir" "$branch" "$trunk" "$root"
  return 0
}

_wt_wls_row() {
  local wtdir="${1:A}" branch="$2" trunk="$3" root="$4"
  local port="-" dirty mark=" " extra="" label
  label="${wtdir:t}"
  [[ -z "$branch" ]] && branch="-"
  [[ -f "$wtdir/.worktree-port" ]] && port=$(<"$wtdir/.worktree-port")
  dirty=$(_wt_dirty "$wtdir")
  if [[ "$wtdir" == "$trunk" ]]; then
    mark="*"
  elif [[ "$wtdir" != "$root" && "$wtdir" != "$root"/* ]]; then
    extra="  ⚠ off-book"
  fi
  printf '%s %-26s %-20s %5s %4s%s\n' "$mark" "$label" "$branch" "$port" "$dirty" "$extra"
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

# wenv : re-sync ENV_FILES from trunk into this worktree (overwrites)
wenv() {
  _wt_conf || return 1
  local cur src f
  # A freshly created trunk has no gitignored files at all — git worktrees never
  # carry them. Seeding it once from a checkout that already runs is what makes
  # every later `wnew` able to copy anything.
  if [[ "$1" == --to-trunk ]]; then
    src="${2:-$PWD}"
    src=$(git -C "$src" rev-parse --show-toplevel 2>/dev/null) || { echo "wenv: $2 is not a worktree"; return 1; }
    [[ "${src:A}" == "${TRUNK:A}" ]] && { echo "wenv: that IS the trunk"; return 1; }
    for f in ${=ENV_FILES}; do
      [[ -f "$src/$f" ]] || continue
      mkdir -p "${TRUNK}/${f:h}"
      cp "$src/$f" "$TRUNK/$f" && echo "  seeded $f"
    done
    return 0
  fi
  cur=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "wenv: not in a git worktree"; return 1; }
  if [[ "${cur:A}" == "${TRUNK:A}" ]]; then
    echo "wenv: this IS the trunk — edit env here, others sync from it"
    return 0
  fi
  _wt_copy_env "$cur" overwrite
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

# wclean : list worktrees under $ROOT whose branch is already an ancestor of $BASE
wclean() {
  _wt_conf || return 1
  local d b name
  _wt_fetch || echo "wclean: fetch failed — merge status is against a local $BASE"
  echo "Merged into $BASE (candidates to remove):"
  for d in "$ROOT"/*(N/); do
    [[ "${d:A}" == "${TRUNK:A}" ]] && continue
    b=$(git -C "$d" branch --show-current 2>/dev/null) || continue
    git -C "$TRUNK" merge-base --is-ancestor "$b" "$BASE" 2>/dev/null || continue
    name="${d:t}"
    [[ -n "$PREFIX" && "$name" == "$PREFIX"* ]] && name="${name#$PREFIX}"
    printf "  %-26s [%s]  uncommitted:%s\n" "$name" "$b" "$(_wt_dirty "$d")"
  done
  echo "remove:  wrm <name>   (force: wrm <name> --force)"
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
  local key_override="" trunk_override="" root_override=""
  local _wt_init_usage="usage: wtinit [--base <ref>] [--cmd <prefix>] [--key <name>] [--trunk <dir>] [--root <dir>]"
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
      *)      echo "$_wt_init_usage"; return 1 ;;
    esac
  done

  git_common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || {
    echo "wtinit: not in a git repo"
    return 1
  }
  primary="${git_common:h}"
  conf="$primary/.worktrees.conf"
  if [[ -f "$conf" ]]; then
    cat "$conf"
    echo "wtinit: already configured"
    return 0
  fi

  # The primary worktree is often a working checkout (kylie-main), not the project
  # name — so --key/--trunk/--root exist rather than a cleverer guess.
  parent="${primary:h}"
  key="${key_override:-${(L)primary:t}}"
  TRUNK="${trunk_override:-$(_wt_tmpl_val TRUNK "$key" "$parent")}"
  ROOT="${root_override:-$(_wt_tmpl_val ROOT "$key" "$parent")}"
  PREFIX="$(_wt_tmpl_val PREFIX "$key" "$parent")"
  [[ -n "$TRUNK" ]]  || TRUNK="$parent/$key-trunk"
  [[ -n "$ROOT" ]]   || ROOT="$parent/$key-wt"
  [[ -n "$PREFIX" ]] || PREFIX="$key-"

  if [[ -f "$TRUNK/.worktrees.conf" ]]; then
    cat "$TRUNK/.worktrees.conf"
    echo "wtinit: already configured"
    return 0
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
  for ig in .worktree-port .worktrees.conf; do
    grep -qxF "$ig" "$gi" 2>/dev/null || echo "$ig" >> "$gi"
  done

  # Registering a command prefix is what makes `<prefix>new` exist in every shell.
  if [[ -n "$cmd_prefix" ]]; then
    mkdir -p "$WT_HOME/repos"
    {
      echo "CMD=$cmd_prefix"
      echo "TRUNK=\"$TRUNK\""
    } > "$WT_HOME/repos/$key.conf"
    _wt_bind "$cmd_prefix" "$TRUNK"
    echo "wtinit: registered ${cmd_prefix}new / ${cmd_prefix}ls / ${cmd_prefix}go / ${cmd_prefix}rm / ${cmd_prefix}clean / ${cmd_prefix}dev / ${cmd_prefix}env / ${cmd_prefix}trunk"
  fi

  cat "$TRUNK/.worktrees.conf"
  if [[ -n "$cmd_prefix" ]]; then
    echo "wtinit: done — now:  ${cmd_prefix}new <name>"
  else
    echo "wtinit: done — now:  wnew <name>   (add a prefix later: wtinit --cmd <p>)"
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
