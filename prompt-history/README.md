# Prompt History

A side panel that shows every prompt you gave a Claude Code agent and what it answered, as cards, for the current session only.

- Each card shows **Input** (your prompt) and **Output** (the text Claude ended the turn on), two lines each.
- A turn still running shows **Working...** with Claude's latest text under it.
- Search filters the cards by input or output text.
- Click a card to read the whole turn as markdown in the panel.
- Click the expand strip on a card's right edge to open the turn in a dialog.
- Newest cards are at the bottom and the list follows them, like a terminal. Scroll up and a **Jump to present** button brings you back.

The panel follows the Claude Code agent in the focused tab. It reads Claude Code's own
session transcript, so nothing needs configuring in Claude Code.

## How it finds the transcript

1. `hc get <terminal> --json` gives the pid of the `claude` running in the agent's terminal.
2. `~/.claude/sessions/<pid>.json` gives that process's session id and start folder.
3. `~/.claude/projects/<folder>/<session id>.jsonl` is the transcript, watched for changes.

Long sessions write megabytes of tool output, so the mod reads the transcript through
`jq` to keep only prompts, answer text and turn timings. Install `jq` for long sessions;
without it the mod falls back to `grep` and may miss the newest turns.

## Install

Copy `mods/prompt-history` into `~/.config/herdr-app/mods/`. Like the GitHub mod it opens
as a window with `mod.open:prompt-history`: merge `keys.json` into
`~/.config/herdr-app/keys.json` for `ctrl-shift-y`.

To show it as a tab-bar panel, add a block with `"mod": "prompt-history"` to your layout's
panel stack and a button for it in your tab bar mod, the same way as GitHub's.
