# GitHub: Pass Issues & PRs to Agent

A [Herdr](https://herdr.dev) mod that shows the GitHub issues, pull requests and
project items of the project you are working in, and hands one to your coding
agent in a click.

- Follows the focused tab: the repo is taken from the folder its terminal is in,
  so it works while an agent like Claude Code is running in that terminal.
- Three tabs: **Issues**, **Pull requests** and **Project** (the GitHub Projects
  linked to the repo, grouped by Status). Each has state or status filters and a
  text filter.
- Click an item to read it (body, labels, comments; a PR's branches and size) in
  the panel, with a back button to return to the list.
- **Send to agent** pastes your prompt and a reference to the item into the tab's
  agent and submits it. **New agent tab** starts a fresh agent in the repo with the
  same prompt as its first task, leaving your current session alone.
- **New issue** (+ on the Issues tab): title, Markdown description and labels.
- The prompts are settings (slider icon), one each for issues, PRs and project items.
- Works in any layout: as a floating window, a block in a layout of yours, or a
  pane in a tab.

## Requirements

- [GitHub CLI](https://cli.github.com) (`gh`), logged in (`gh auth login`).
- For the Project tab, the `read:project` scope: `gh auth refresh -s read:project`.
- `git`.
- For spaces on another machine, both on that machine.

## Install

Tell your coding agent:

```
Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/ReyArlena/herdr-mods/tree/main/github-integration
```

Or by hand: copy `mods/github-integration/` into `~/.config/herdr-app/mods/` and
merge `keys.json` into yours. For development, see the
[repo README](../README.md#development).

## Opening it

### As a window (any layout, nothing to edit)

`ctrl-shift-g` toggles it (`mod.open:github-integration`, from `keys.json`). It
floats over the window, can be dragged and remembers where you left it. On macOS
you may prefer `cmd-shift-g`; bind whichever you like.

### As a panel in your layout

Herdr's own layouts are read-only, so clone one first:

```sh
herdr-app do layout.clone '{"name":"main","as":"my-layout"}'
```

Then add a block for the mod wherever you want it, for example beside the
terminals in the `work-body` row:

```json
{ "id": "github-integration", "type": "block", "size": { "px": 380 }, "content": { "mod": "github-integration" } }
```

or as another page of the side panel stack (`panel-body`), next to Files and
Changes:

```json
{ "id": "github-integration", "type": "block", "content": { "mod": "github-integration" } }
```

A side panel page needs a button to reach it. Herdr's `tabs` mod hard-codes its
Files and Changes buttons, so clone it (`mod.clone {"name":"tabs","as":"my-tabs"}`),
point your layout's `tabs` block at the clone, and in its `main.js`:

1. add the button after Changes:
   ```js
   .child(panelButton("github-integration", "GitHub", "mods/github-integration/icons/github.svg"))
   ```
2. add the panel to `enabled`, so switching spaces doesn't close it:
   ```js
   const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), "github-integration"];
   ```

Without a button, `layout.select {"stack":"panel-body","child":"github-integration"}`
and `layout.show {"id":"panel"}` (or a key bound to them) show it too.

### As a pane

```sh
herdr-app do pane.split '{"direction":"right","mod":"github-integration"}'
```

## How it behaves

- **Checks gh first.** Before anything else, on the focused tab's machine:
  `gh --version` (installed?) and `gh auth status` (logged in, token valid, GitHub
  reachable). A problem shows as a warning with what to do: a **Copy command**
  button for the command that fixes it (`gh auth login`), the install page when gh
  is missing, and **Check again**. The same check reads the token's scopes, so the
  Project tab asks for `read:project` (with `gh auth refresh -s read:project` to
  copy) before calling GitHub. Any error that names a command gets the copy button.
- **Which repo:** the focused terminal's folder. When a mod pane or block has the
  focus instead, the tab's first terminal decides. `git rev-parse --show-toplevel`
  finds the repo root and `gh repo view` its GitHub name (so `gh repo set-default`
  is honoured for forks). An agent moving between folders of the same repo changes
  nothing, and a short visit outside the repo (a temp folder) is ignored.
- **Auto refresh, only while visible.** While the panel is on screen and showing a
  list or an item, it reads that again every 30 s (Settings: Off, 15s, 30s, 1m or
  5m). These background reads don't show "Loading…", and one that fails (offline
  for a moment) keeps what was shown. A hidden panel, a form or a failing gh check
  reads nothing. It also reads when it becomes visible (if the last read is more
  than 10 s old), when the focused tab's repo changes, when you pick a tab or
  filter it hasn't read yet, and on Refresh.
- **Issues:** Open, Closed or All, up to 100, most recently updated first.
- **Pull requests:** Open, Merged, Closed or All, up to 100, with branch and draft
  state. A PR's page adds `head → base`, lines added and removed, files changed
  and the review decision.
- **Project:** the open GitHub Projects (v2) linked to the repo; with several,
  chips pick one (remembered per repo). Items are grouped by their Status, in the
  project's own order, up to 300. Status chips choose which groups show (Done is
  hidden at first; remembered per project). Draft items show their text; issues
  and PRs open their full page, which can be in another repo.
- **Send to agent** uses `hc send`: the text is pasted, then Enter is pressed. The
  agent is the tab's focused agent, else the one that changed last. An agent
  waiting for an answer (blocked) refuses it: reply to it first.
- **What the agent gets** (default prompts, change them in Settings):
  ```
  Can you help me address this GitHub issue? Please investigate and ask for input or changes before proceeding. Once done, ask me if I'd like to close the issue with a comment or move on. Keep a closing comment short: "Fixed in <short commit SHA>." (or "Fixed in #<PR>.") and one line on what changed, or why it won't be done.

  owner/repo#123: Issue title
  https://github.com/owner/repo/issues/123

  If I want to close it, don't close it yourself: open Herdr's close dialog with your comment filled in, for me to review:
  sh '~/.config/herdr-app/mods/github-integration/close-issue.sh' owner/repo 123 <<'EOF'
  <closing comment>
  EOF
  (add "not planned" after 123 if it won't be done)
  ```
  ```
  Can you help me work on this GitHub PR? Please investigate and ask for input or changes before proceeding. Once done, ask me if I'd like to comment on the PR, merge it, or move on. Keep a comment short: what changed, with the short commit SHAs it refers to.

  owner/repo#124: PR title
  https://github.com/owner/repo/pull/124
  ```
  ```
  Can you help me work on this GitHub Project item? Please investigate and ask for input or changes before proceeding. Once done, ask me if I'd like to move the item to another status, close it with a comment, or move on. Keep a closing comment short: "Fixed in <short commit SHA>." (or "Fixed in #<PR>.") and one line on what changed, or why it won't be done.

  Project: Roadmap (https://github.com/users/owner/projects/1)
  Status: In Progress
  Issue: owner/repo#123: Issue title
  https://github.com/owner/repo/issues/123
  ```
  Issues and PRs leave their body out: the agent reads them and their comments
  with `gh`, which also works for private repos it can reach. A draft project item
  can't be looked up that way, so its title and text go along in full.
- **New agent tab** starts the first installed agent Herdr knows
  (`knownAgents()`, most used first) in the repo root, in the same space, named
  after the item.
- **New issue** creates it with `gh issue create`, then opens it. Labels come from
  the repo's label list.
- **Close issue** (on an open issue's page, also from the Project tab) opens a dialog:
  a reason (Completed or Not planned) and an optional closing comment, then
  `gh issue close`. Every open copy of the panel reads that repo again afterwards.
- **Agents can prepare the close.** Issue prompts (also project items that are
  issues) end with how to hand a closing comment back: the agent runs
  `close-issue.sh` from the mod's folder with the repo, number and comment, and the
  Close issue dialog opens in Herdr with that comment filled in. You review it and
  close, or cancel; the agent never closes anything itself. The script leaves the
  request in `~/.config/herdr-app/data/github-integration/inbox/`, where a running
  copy of the mod takes it (the first one to remove the file); with none running,
  it opens the mod's window, which takes it as it starts. Requests older than two
  minutes are dropped. Spaces on another machine leave this line out: the script
  and the dialog are on this one.
- **Open on GitHub:** a button on every item's page (a draft opens in its project),
  and the header's arrow icon opens the current list: the repo's issues or pull
  requests, or the project.
- **Settings** are stored in Herdr's shared state (`github-integration.settings`):
  the tab, filters, project choices, the auto refresh interval and any prompt you
  changed. A prompt left at
  its default isn't saved, so it follows the default when that changes. Every copy
  of the mod uses them.

## What it runs

Tell people before installing: this mod runs programs and reaches the network
through them.

- `git rev-parse --show-toplevel` in the focused terminal's folder.
- `gh repo view`, `gh issue list|view|create|close`, `gh pr list|view`, `gh label list`
  and `gh api graphql` for projects (network, with your gh login).
- `hc send <agent> <text>` to type into an agent.
- `close-issue.sh` (run by an agent, not by the mod) writes a request file into
  `~/.config/herdr-app/data/github-integration/inbox/`; the mod reads and deletes it.
- It changes GitHub only when you create or close an issue.

## Files

```
mods/github-integration/
  main.js      the view: tabs, lists, detail, new issue, settings, sending
  github.js    repo detection, gh calls, prompt text
  ui.js        shared pieces: buttons, chips, badges, warnings
  close-issue.sh  for agents: opens the Close issue dialog with a comment filled in
  mod.json     opens as a 480 px window, 85% of Herdr's height
  icons/       github, project, plus, chevron-left, refresh, external, settings, close
keys.json      ctrl-shift-g
```
