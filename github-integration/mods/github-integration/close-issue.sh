#!/bin/sh
# Opens the GitHub mod's "Close issue" dialog in Herdr with a closing comment filled in.
# The person reviews it there and closes the issue, or cancels. Nothing is closed here.
#
#   sh close-issue.sh <owner/repo> <number> [completed|"not planned"] <<'EOF'
#   Fixed in abc1234: one line on what changed.
#   EOF
#
# The comment comes on stdin (Markdown, any length). The request goes into the mod's
# inbox; a running copy of the mod takes it, else this opens the mod's window, which
# takes it as it starts.
set -eu

usage="usage: close-issue.sh <owner/repo> <number> [completed|not planned] < comment"
repo=${1:?$usage}
number=${2:?$usage}
reason=${3:-completed}
case "$repo" in */*) ;; *) echo "close-issue.sh: repo must be owner/name" >&2; exit 2 ;; esac
case "$number" in '' | *[!0-9]*) echo "close-issue.sh: number must be digits" >&2; exit 2 ;; esac
case "$reason" in completed | "not planned") ;; *) echo "close-issue.sh: reason is completed or \"not planned\"" >&2; exit 2 ;; esac
command -v herdr-app >/dev/null 2>&1 || { echo "close-issue.sh: herdr-app not found; this opens a dialog in the Herdr app on this machine" >&2; exit 1; }

inbox="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/data/github-integration/inbox"
mkdir -p "$inbox"
name="close-$(date +%s)-$$.txt"
# Written beside the inbox name first, so the mod never reads half a request.
{ printf '%s\n%s\n%s\n' "$repo" "$number" "$reason"; [ -t 0 ] || cat; } > "$inbox/.$name"
mv "$inbox/.$name" "$inbox/$name"

taken() { [ ! -e "$inbox/$name" ]; }
wait_taken() { i=0; while [ "$i" -lt "$1" ] && ! taken; do sleep 0.2; i=$((i + 1)); done; }

wait_taken 10
if ! taken; then
  herdr-app do mod.open '{"name":"github-integration"}' >/dev/null 2>&1 || true
  wait_taken 25
fi
if taken; then
  echo "Opened the Close issue dialog for $repo#$number in Herdr, with the comment filled in. The person reviews and confirms it there."
else
  rm -f "$inbox/$name"
  echo "close-issue.sh: Herdr didn't take the request (is the app running, with the github-integration mod?)." >&2
  echo "Close it directly instead: gh issue close $number -R $repo --reason \"$reason\" --comment \"...\"" >&2
  exit 1
fi
