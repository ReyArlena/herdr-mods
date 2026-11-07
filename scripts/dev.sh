#!/usr/bin/env bash
# Develop these mods from this repo: copy them into Herdr and keep the copy in step.
#
#   scripts/dev.sh sync [mod...]     copy mods into $HERDR_APP_HOME/mods (default: all)
#   scripts/dev.sh watch             sync once, then again whenever a mod's files change
#   scripts/dev.sh remove [mod...]   delete those copies (only ones this script made)
#
# Why a copy and not a symlink: Herdr does not follow a symlinked mod folder. Its
# icons and images (svg(), image()) don't load through the link, and saving a file
# through it doesn't hot-reload. A real folder kept in sync behaves like any mod.
# Edit in the repo only: the copy is overwritten on every sync.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
HERDR_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
MODS="$HERDR_HOME/mods"
MARK=".herdr-mods-dev"   # hidden, so Herdr ignores it; says this script owns the copy

# Every <package>/mods/<mod>/ folder in this repo, as "name<TAB>path".
all_mods() {
  find "$REPO" -mindepth 3 -maxdepth 3 -type d -path "$REPO/*/mods/*" -not -path "$REPO/.git/*" |
    sort | while read -r dir; do printf '%s\t%s\n' "$(basename "$dir")" "$dir"; done
}

selected() {
  if [ $# -eq 0 ]; then all_mods; return; fi
  local want
  for want in "$@"; do
    all_mods | awk -F'\t' -v n="$want" '$1 == n' | grep . || { echo "No mod named $want in this repo" >&2; exit 1; }
  done
}

ours() { [ -f "$1/$MARK" ] && [ "$(cat "$1/$MARK")" = "$2" ]; }

sync_one() {
  local name="$1" dir="$2" target="$MODS/$1"
  # An older setup of this repo symlinked mods; replace those links.
  if [ -L "$target" ] && [ "$(readlink "$target")" = "$dir" ]; then rm "$target"; fi
  if [ -e "$target" ] && ! ours "$target" "$dir"; then
    echo "skip    $name: $target exists and was not made by this script; move it aside first" >&2
    return 1
  fi
  mkdir -p "$target"
  # Herdr writes jsconfig.json and *.d.ts into mod folders itself: leave them alone on both sides.
  rsync -a --delete --exclude "$MARK" --exclude jsconfig.json --exclude '*.d.ts' "$dir/" "$target/"
  printf '%s' "$dir" > "$target/$MARK"
}

sync_mods() {
  mkdir -p "$MODS"
  selected "$@" | while IFS=$'\t' read -r name dir; do
    sync_one "$name" "$dir" || continue
    echo "synced  $name -> $MODS/$name"
    herdr-app check "$MODS/$name" || true
  done
}

remove_mods() {
  selected "$@" | while IFS=$'\t' read -r name dir; do
    target="$MODS/$name"
    if ours "$target" "$dir"; then rm -rf "$target"; echo "removed $name"; fi
  done
}

watch() {
  command -v inotifywait >/dev/null || { echo "watch needs inotifywait (sudo pacman -S --needed inotify-tools)" >&2; exit 1; }
  sync_mods
  echo "Watching $REPO for mod changes (ctrl+c to stop)"
  inotifywait -m -r -q -e close_write,moved_to,create,delete --format '%w%f' \
    --exclude '(\.git/|jsconfig\.json$|\.d\.ts$|\.swp$|~$)' "$REPO" |
    while read -r path; do
      rel="${path#"$REPO"/}"
      case "$rel" in */mods/*/*) ;; *) continue ;; esac
      name="$(printf '%s' "$rel" | cut -d/ -f3)"
      dir="$REPO/$(printf '%s' "$rel" | cut -d/ -f1-3)"
      [ -d "$dir" ] || continue
      if sync_one "$name" "$dir"; then echo "synced  $name ($rel)"; fi
    done
}

case "${1:-}" in
  sync) shift; sync_mods "$@" ;;
  watch) watch ;;
  remove) shift; remove_mods "$@" ;;
  *) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
