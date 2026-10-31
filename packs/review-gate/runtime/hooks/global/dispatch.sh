#!/bin/sh
dispatch() {
  name=$1; project=$2; shift 2
  folder=$(CDPATH= cd -P "${0%/*}" && pwd) || return 1
  if [ "$name" = pre-push ]; then
    common=$(git rev-parse --git-common-dir) || return 1
  else
    common=$(git rev-parse --git-common-dir 2>/dev/null) || {
      printf 'handled\n' >&3
      exec 3>&-
      return 0
    }
  fi
  own=
  if [ -d "$common/hooks" ]; then
    local_folder=$(CDPATH= cd -P "$common/hooks" && pwd) || return 1
    if [ "$local_folder" != "$folder" ] && [ -x "$local_folder/$name" ]; then
      # Also avoid a single repo hook symlink pointing back to a global entry.
      if ! [ "$local_folder/$name" -ef "$folder/run-hook" ]; then own=$local_folder/$name; fi
    fi
  fi
  if [ "$name" = pre-push ] && [ "$project" = 1 ]; then
    printf 'handled\n' >&3
    exec 3>&-
    # node: the path pinned in ../node-path when it is executable, else node on PATH.
    node=
    if [ -r "$folder/../node-path" ]; then IFS= read -r node < "$folder/../node-path" || :; fi
    { [ -n "$node" ] && [ -x "$node" ]; } || node=$(command -v node 2>/dev/null) || node=
    if [ -z "$node" ]; then
      echo 'Push blocked: node is missing; the review gate for this opted-in repo cannot run.' >&2
      return 1
    fi
    exec "$node" "$folder/push.mjs" "$own" "$@"
  fi
  printf 'handled\n' >&3
  exec 3>&-
  if [ -n "$own" ]; then exec "$own" "$@"; fi
  return 0
}
dispatch "$@"
