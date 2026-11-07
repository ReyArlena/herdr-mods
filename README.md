# herdr-mods

Mods for [Herdr](https://herdr.dev), the desktop app for terminals and coding agents.

| Mod | What it does |
|---|---|
| [GitHub: Pass Issues & PRs to Agent](github-integration/) | Lists the current project's GitHub issues, PRs and project items, sends one to your agent, creates issues |

Each top-level folder is one shareable package, laid out the way Herdr expects:

```
<package>/
  README.md
  keys.json            keys the mod expects (merge into ~/.config/herdr-app/keys.json)
  mods/<mod-name>/     the mod itself: main.js, mod.json, assets
```

## Install

Tell your coding agent, for example:

```
Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/ReyArlena/herdr-mods/tree/main/github-integration
```

## Development

Work on the mods in this repo and keep a copy of each in Herdr's `mods/` folder,
synced as you save.

```sh
git clone https://github.com/ReyArlena/herdr-mods ~/Projects/herdr-mods
cd ~/Projects/herdr-mods

scripts/dev.sh sync        # copy every mod into ~/.config/herdr-app/mods, then herdr-app check it
scripts/dev.sh watch       # leave running: re-syncs a mod on save, and Herdr hot-reloads it
```

By hand, for one mod:

```sh
rsync -a --delete --exclude jsconfig.json --exclude '*.d.ts' \
  ~/Projects/herdr-mods/github-integration/mods/github-integration/ \
  ~/.config/herdr-app/mods/github-integration/
herdr-app check ~/.config/herdr-app/mods/github-integration
```

Then merge the package's `keys.json` into `~/.config/herdr-app/keys.json` (for
example `"ctrl-shift-g": "mod.open:github-integration"` under `global`).

Notes:

- **Why not a symlink:** Herdr doesn't follow a symlinked mod folder. Icons and
  images (`svg()`, `image()`) don't load through the link, and saving through it
  doesn't hot-reload. A synced real folder behaves like any other mod.
- **Edit in the repo only.** The copy in `~/.config/herdr-app/mods/` is overwritten
  on every sync. The script marks its copies with a hidden `.herdr-mods-dev` file
  and refuses to overwrite a folder it didn't make.
- `watch` needs `inotifywait` (`sudo pacman -S --needed inotify-tools` on Arch).
- `herdr-app check <mod folder>` loads the mod and renders it once; run it after
  changes. `herdr-app status` lists load errors from the running app, and
  `herdr-app shot` saves a screenshot of the window.
- Herdr writes `jsconfig.json` and `*.d.ts` type files into each mod folder when it
  loads it. They are ignored by git; read them for the API (`herdr.d.ts`,
  `gpui-kit.d.ts`) along with `~/.config/herdr-app/AGENTS.md`.
- `HERDR_APP_HOME` points the script at another Herdr home.
- `scripts/dev.sh remove` deletes the copies it made.

<!-- test line for #2 -->
