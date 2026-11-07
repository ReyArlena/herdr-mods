// GitHub: Pass Issues & PRs to Agent.
// Issues, pull requests and project items of the repo behind the focused tab. Open one,
// then paste a reference to it into the tab's agent, or start a new agent tab with it.
// Works as a window (mod.open), a layout block or a pane, in any layout. It never polls:
// it reads GitHub when shown, when the tab's repo changes, and on Refresh.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Textarea, TextareaState, TextView } from "gpui-base";
import { agents, appHome, closeOverlay, focused, hc, knownAgents, layout, notify, openOverlay, panes, props, readTextFile, run, settings, setShared, shared, spaces, theme, watchFolder } from "herdr";
import * as fs from "fs/promises";
import {
  DEFAULT_PROMPTS, ISSUE_STATES, PR_STATES, NO_STATUS, ago, matches, repoName, repoRoot,
  listIssues, viewIssue, listPrs, viewPr, listLabels, createIssue, linkedProjects, projectItems,
  issuePrompt, prPrompt, projectPrompt, checkGh, canReadProjects, PROJECT_SCOPE_COMMAND,
  OLD_DEFAULT_PROMPTS, CLOSE_REASONS, closeIssue, itemUrl, closeHint, issueSummary,
} from "./github.js";
import { ICONS, iconButton, pill, chip, labelChips, badge, note, stateLook, optionColor, problem } from "./ui.js";

const NAME = "github-integration";
const SETTINGS = `${NAME}.settings`;
// Bumped after something changed on GitHub (an issue closed), so every copy reads it again.
const CHANGED = `${NAME}.changed`;
// Where close-issue.sh leaves requests from agents: "close-<unix seconds>-<pid>.txt" holding
// repo, number and reason on their own lines, then the comment. Older than this is ignored.
const inbox = () => `${appHome()}/data/${NAME}/inbox`;
const REQUEST_MAX_AGE_S = 120;
// Showing it again within this long reuses what it read; Refresh always reads.
const FRESH_MS = 10000;
const TABS = [["issues", "Issues"], ["prs", "Pull requests"], ["project", "Project"]];
const STATE_LABEL = { open: "Open", closed: "Closed", merged: "Merged", all: "All" };

// Settings live in Herdr's shared state, so every copy of the mod agrees.
// Only prompts someone changed are kept: one left at its default follows new defaults.
function customPrompts(s) {
  const saved = { ...(s.issuePrompt ? { issue: s.issuePrompt } : {}), ...(s.prompts ?? {}) };
  return Object.fromEntries(Object.entries(saved).filter(([k, v]) => v && v !== DEFAULT_PROMPTS[k] && !OLD_DEFAULT_PROMPTS.includes(v)));
}
function settingsNow() {
  const s = shared(SETTINGS) ?? {};
  return {
    tab: "issues", issueState: "open", prState: "open", projects: {}, hidden: {},
    ...s,
    prompts: { ...DEFAULT_PROMPTS, ...customPrompts(s) },
  };
}
function setSettings(patch) {
  const { issuePrompt: _old, ...saved } = shared(SETTINGS) ?? {};
  const next = { ...saved, ...patch };
  setShared(SETTINGS, { ...next, prompts: customPrompts(next) });
}

// The focused tab and the folder its terminal is in. A mod pane or block holding the
// focus has no folder, so the tab's first terminal answers instead.
function context() {
  const f = focused();
  if (!f) return null;
  const space = spaces().find((s) => s.id === f.space);
  const cwd = (f.terminal && f.cwd) || panes().find((p) => p.tab === f.tab && p.terminal && p.cwd)?.cwd || space?.folder || null;
  return { space: f.space, tab: f.tab, on: space?.machine ?? null, cwd };
}

// Is a copy of this mod on screen? An overlay is while it exists; a pane while its tab
// shows; a layout block while no ancestor is hidden and every stack shows its branch.
function visibleIn(node) {
  if (!node || node.hidden) return false;
  if (node.content?.mod === NAME) return true;
  if ((node.floating ?? []).some(visibleIn)) return true;
  const kids = node.children ?? [];
  if (node.type === "stack") return visibleIn(kids.find((c) => c.id === node.active) ?? kids[0]);
  return kids.some(visibleIn);
}
function isShown() {
  if (props()?.overlay) return true;
  const tab = spaces().find((s) => s.active)?.tabs.find((t) => t.active)?.id;
  if (panes().some((p) => p.mod === NAME && p.tab === tab)) return true;
  return visibleIn(layout());
}

// The agent to send to: the tab's focused agent, else the one that changed last.
function agentIn(tab) {
  const list = agents().filter((a) => a.tab === tab);
  return list.find((a) => a.focused) ?? list.toSorted((a, b) => b.seq - a.seq)[0] ?? null;
}

export default class GitHub extends View {
  init(_props, cx) {
    // Opened as the close-issue dialog by another copy (see openCloseDialog).
    if (props()?.mode === "close-issue") {
      const p = props();
      const comment = TextareaState.new({ placeholder: "Leave a comment (optional, Markdown)", value: p.comment ?? "" });
      comment.set_auto_grow(4, 10);
      comment.focus();
      this.dialog = { ...p, reason: p.reason ?? "completed", comment, closing: false, error: null, state: p.state ?? null };
      // A request from an agent knows only repo and number: look up the rest.
      if (!p.title) {
        cx.spawn(async (cx) => {
          const r = await issueSummary(p.repo, p.number, p.on ?? null);
          if (r.item) Object.assign(this.dialog, { title: r.item.title, state: r.item.state });
          else this.dialog.error = r.error;
          cx.notify();
        });
      }
      return;
    }
    this.watchInbox(cx);
    this.changedAt = shared(CHANGED)?.at ?? 0;
    this.view = "list";         // "list" | "detail" | "new" | "settings"
    this.detail = null;         // { kind: "issue" | "pr" | "draft", repo, number, stub, item?, project? }
    this.place = null;          // { repo, url, root, on, tab } or { error, cwd, on, tab }
    this.cwdKey = null; this.resolveSeq = 0;
    this.roots = new Map();     // machine|folder -> { root } or { error }: no git rerun on tab switches
    this.names = new Map();     // machine|root -> gh's repo name, asked once per session
    // Everything read from GitHub, by what was asked. A read stores its answer under its own
    // key, so an answer never lands in the wrong place and never has to be thrown away.
    this.cache = new Map(); this.inflight = new Set();
    this.sending = false; this.wasShown = false;
    this.handle = cx.focus_handle();
    this.filter = InputState.new({ placeholder: "Filter…" });
    this.filter.on("change", (_e, cx) => cx.notify());
    this.form = null; this.prompts = null;
  }

  // ---- where we are -------------------------------------------------------------

  // Follows the focused tab's folder to its repo. Folders change a lot while an agent works
  // (subfolders, a temp dir for a moment), so only a different repo changes anything, and a
  // non-repo folder in the same tab is ignored when that tab already showed a repo.
  resolve(ctx, cx) {
    const key = `${ctx.on ?? ""}|${ctx.cwd ?? ""}`;
    if (key === this.cwdKey) return;
    this.cwdKey = key;
    const token = ++this.resolveSeq, tab = ctx.tab, on = ctx.on;
    cx.spawn(async (cx) => {
      let root = this.roots.get(key);
      if (!root) { root = await repoRoot(ctx.cwd, on); this.roots.set(key, root); }
      if (token !== this.resolveSeq) return;
      if (root.error) {
        if (this.place?.repo && this.place.tab === tab) return;
        this.place = { error: root.error, cwd: ctx.cwd, on, tab };
        cx.notify(); return;
      }
      if (this.place?.repo && this.place.root === root.root && this.place.on === on) { this.place.tab = tab; return; }
      const nameKey = `${on ?? ""}|${root.root}`;
      let name = this.names.get(nameKey);
      if (!name) { name = await repoName(root.root, on); if (name.repo) this.names.set(nameKey, name); }
      if (token !== this.resolveSeq) return;
      const changed = this.place?.repo !== name.repo || this.place?.on !== on;
      this.place = name.repo ? { ...name, root: root.root, on, tab } : { error: name.error, cwd: root.root, on, tab };
      if (changed && this.view !== "settings") this.toList();
      cx.notify();
    });
  }

  pkey() { return `${this.place?.on ?? ""}|${this.place?.repo}`; }

  // ---- reading GitHub -----------------------------------------------------------

  // Reads key with fn unless an answer younger than maxAge is there (Infinity: any answer,
  // 0: always). Errors are answers too, so a failing read isn't retried until Refresh.
  load(key, fn, cx, maxAge) {
    if (this.inflight.has(key)) return;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < maxAge) return;
    this.inflight.add(key);
    cx.spawn(async (cx) => {
      let r;
      try { r = await fn(); } catch (e) { r = { error: String(e?.message ?? e) }; }
      this.cache.set(key, { ...r, at: Date.now() });
      this.inflight.delete(key);
      cx.notify();
    });
  }

  issuesKey(s) { return `${this.pkey()}|issues|${s.issueState}`; }
  prsKey(s) { return `${this.pkey()}|prs|${s.prState}`; }
  projectsKey() { return `${this.pkey()}|projects`; }
  projectKey(id) { return `${this.place?.on ?? ""}|project|${id}`; }
  labelsKey() { return `${this.pkey()}|labels`; }
  detailKey(d) { return `${this.place?.on ?? ""}|${d.kind}|${d.repo}#${d.number}`; }

  // The project shown: the one picked for this repo, else the first linked one.
  currentProject(s) {
    const list = this.cache.get(this.projectsKey())?.items;
    if (!list?.length) return null;
    return list.find((p) => p.id === s.projects[this.place.repo]) ?? list[0];
  }

  // ---- gh itself ---------------------------------------------------------------

  healthKey() { return `health|${this.healthOn ?? ""}`; }
  health() { return this.cache.get(this.healthKey()); }

  // Checks gh on the focused tab's machine once; again on Check again, on Refresh, and when
  // the panel is shown again while the last check failed.
  checkHealth(on, cx, maxAge) {
    this.healthOn = on;
    this.load(this.healthKey(), () => checkGh(on), cx, maxAge);
  }

  // Forgets the failed check and what it led to, then checks again.
  recheck(cx) {
    this.cache.delete(this.healthKey());
    for (const [k, v] of [...this.cache]) if (v.error) this.cache.delete(k);
    this.cwdKey = null; this.place = this.place?.repo ? this.place : null;
    this.checkHealth(this.healthOn, cx, 0);
    cx.notify();
  }

  // Makes sure what the current view shows is read (or being read).
  ensure(cx, maxAge) {
    const place = this.place;
    if (!place?.repo || !this.health()?.ok) return;
    const s = settingsNow();
    if (this.view === "list") {
      if (s.tab === "issues") this.load(this.issuesKey(s), () => listIssues(place, s.issueState), cx, maxAge);
      else if (s.tab === "prs") this.load(this.prsKey(s), () => listPrs(place, s.prState), cx, maxAge);
      else if (canReadProjects(this.health())) {
        this.load(this.projectsKey(), () => linkedProjects(place), cx, maxAge);
        const p = this.currentProject(s);
        if (p) this.load(this.projectKey(p.id), () => projectItems(place, p.id), cx, maxAge);
      }
    } else if (this.view === "detail" && this.detail && this.detail.kind !== "draft") {
      const d = this.detail;
      this.load(this.detailKey(d), () => (d.kind === "pr" ? viewPr(place, d.repo, d.number) : viewIssue(place, d.repo, d.number)), cx, maxAge);
    } else if (this.view === "new") {
      this.load(this.labelsKey(), () => listLabels(place), cx, maxAge);
    }
  }

  // ---- moving between views -----------------------------------------------------

  toList() {
    this.form?.title.release(); this.form?.body.release(); this.form = null;
    this.view = "list"; this.detail = null;
  }

  openDetail(d, cx) {
    this.view = "detail"; this.detail = d;
    this.ensure(cx, FRESH_MS);
    cx.notify();
  }

  openNew(cx) {
    const title = InputState.new({ placeholder: "Title" });
    const body = TextareaState.new({ placeholder: "Description (Markdown)" });
    body.set_auto_grow(6, 16);
    this.form = { title, body, labels: new Set(), creating: false, error: null };
    title.on("change", (_e, cx) => cx.notify());
    title.focus();
    this.view = "new";
    this.ensure(cx, Infinity);
    cx.notify();
  }

  openSettings(cx) {
    const p = settingsNow().prompts;
    const box = (kind) => { const s = TextareaState.new({ value: p[kind], placeholder: DEFAULT_PROMPTS[kind] }); s.set_auto_grow(3, 10); return s; };
    this.prompts = { issue: box("issue"), pr: box("pr"), project: box("project") };
    this.back = this.view === "settings" ? this.back : { view: this.view, detail: this.detail };
    this.view = "settings";
    cx.notify();
  }

  closeSettings(cx) {
    for (const s of Object.values(this.prompts ?? {})) s.release();
    this.prompts = null;
    const b = this.back ?? { view: "list" };
    this.view = b.view === "new" || (b.view === "detail" && !b.detail) ? "list" : b.view;
    this.detail = this.view === "detail" ? b.detail : null;
    cx.notify();
  }

  goBack(cx) {
    if (this.view === "settings") return this.closeSettings(cx);
    this.toList();
    this.ensure(cx, FRESH_MS);
    cx.notify();
  }

  saveSettings(cx) {
    const prompts = Object.fromEntries(Object.entries(this.prompts).map(([k, s]) => [k, s.value().trim() || DEFAULT_PROMPTS[k]]));
    setSettings({ prompts });
    notify({ title: "GitHub settings saved", level: "success", timeout: 2500 });
    this.closeSettings(cx);
  }

  // Closes this copy when it is a window. (Not `close`: Herdr calls that on removal.)
  closeWindow() {
    const id = props()?.overlay;
    if (id) closeOverlay(id);
  }

  // Something changed on GitHub for this repo: drop what was read about it.
  invalidate(repo) {
    for (const k of [...this.cache.keys()]) {
      if (k.includes(`|${repo}|`) || k.includes(`|${repo}#`) || k.includes("|project|")) this.cache.delete(k);
    }
  }

  // The page for what's shown: the open item, else the tab's list on GitHub.
  pageUrl(s) {
    const place = this.place, d = this.detail;
    if (!place?.repo) return null;
    if (this.view === "detail" && d) {
      if (d.kind === "draft") return itemUrl(d.project, d.item);
      return this.cache.get(this.detailKey(d))?.item?.url ?? d.stub?.url ?? null;
    }
    if (this.view !== "list") return null;
    if (s.tab === "issues") return `${place.url}/issues`;
    if (s.tab === "prs") return `${place.url}/pulls`;
    return this.currentProject(s)?.url ?? `${place.url}/projects`;
  }

  // ---- closing an issue -----------------------------------------------------------

  // Close requests from agents (close-issue.sh): each opens the dialog with the agent's
  // comment filled in, for the person to review. Every main copy watches; removing the
  // file is the claim, so of two copies only one opens the dialog.
  watchInbox(cx) {
    cx.spawn(async () => {
      try {
        await fs.mkdir(inbox(), { recursive: true });
        for (;;) {
          await this.takeRequests();
          await watchFolder(inbox());
        }
      } catch { /* no inbox: requests from agents don't open here */ }
    });
  }

  async takeRequests() {
    const names = await fs.readdir(inbox()).catch(() => []);
    for (const name of names) {
      const m = /^close-(\d+)-\d+\.txt$/.exec(name);
      if (!m) continue;
      const path = `${inbox()}/${name}`;
      const text = await readTextFile(path).catch(() => null);
      try { await fs.unlink(path); } catch { continue; }
      if (text === null || Date.now() / 1000 - Number(m[1]) > REQUEST_MAX_AGE_S) continue;
      const [repo = "", number = "", reason = "", ...comment] = text.split("\n");
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo.trim()) || !/^\d+$/.test(number.trim())) continue;
      openOverlay({ mod: NAME, kind: "dialog", modal: true, width: 440, height: 420,
        props: { mode: "close-issue", repo: repo.trim(), number: Number(number), on: null, root: null,
          reason: CLOSE_REASONS.some(([v]) => v === reason.trim()) ? reason.trim() : "completed",
          comment: comment.join("\n").trim() } });
    }
  }

  openCloseDialog(d, item) {
    const place = this.place;
    openOverlay({ mod: NAME, kind: "dialog", modal: true, width: 440, height: 400,
      props: { mode: "close-issue", repo: d.repo, number: d.number, title: item.title, root: place.root, on: place.on } });
  }

  closeTheIssue(cx) {
    const dlg = this.dialog;
    if (dlg.closing) return;
    dlg.closing = true; dlg.error = null; cx.notify();
    cx.spawn(async (cx) => {
      const r = await closeIssue({ root: dlg.root, on: dlg.on }, dlg.repo, dlg.number, { comment: dlg.comment.value(), reason: dlg.reason });
      dlg.closing = false;
      if (r.error) { dlg.error = r.error; cx.notify(); return; }
      setShared(CHANGED, { repo: dlg.repo, at: Date.now() });
      notify({ title: `Closed issue #${dlg.number}`, body: dlg.comment.value().trim() ? "With your comment." : undefined, level: "success", timeout: 3000 });
      closeOverlay(props().overlay);
    });
  }

  dialogView(t) {
    const dlg = this.dialog;
    return v_flex().id("gh-close-dialog").size_full().min_h(0).p(16).gap(10).bg(t.background).text_color(t.foreground).text_size(13)
      .child(v_flex().gap(2)
        .child(div().text_size(14).font_semibold().child(`Close issue #${dlg.number}`))
        .child(div().truncate().text_size(12).text_color(t.dim).child(`${dlg.repo} · ${dlg.title ?? ""}`)))
      .child(div().pt(4).text_size(12).font_semibold().text_color(t.muted).child("Reason"))
      .child(h_flex().gap(5).children(CLOSE_REASONS.map(([value, label]) =>
        chip(t, `gh-cr-${value.replace(" ", "-")}`, label, dlg.reason === value, (cx) => { dlg.reason = value; cx.notify(); }))))
      .child(div().pt(4).text_size(12).font_semibold().text_color(t.muted).child("Comment"))
      .child(div().id("gh-close-comment").w_full().rounded(6).border_1().border_color(t.input).bg(t.surface)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Textarea.new(dlg.comment).w_full().px(8).py(6).text_size(13).text_color(t.foreground)))
      .when(dlg.state === "CLOSED", (el) => el.child(div().text_size(12).text_color(t.blocked).child("This issue is already closed.")))
      .when(Boolean(dlg.error), (el) => el.child(div().text_size(12).text_color(t.ansi1).child(dlg.error)))
      .child(div().flex_1())
      .child(h_flex().gap(8).justify_end()
        .child(pill(t, "gh-close-cancel", "Cancel", () => closeOverlay(props().overlay)))
        .child(pill(t, "gh-close-go", dlg.closing ? "Closing…" : "Close issue", (cx) => this.closeTheIssue(cx), { strong: true, disabled: dlg.closing || dlg.state === "CLOSED" })));
  }

  // ---- acting -------------------------------------------------------------------

  createIssue(cx) {
    const f = this.form, place = this.place;
    const title = f?.title.value().trim();
    if (!f || !title || f.creating) return;
    f.creating = true; f.error = null; cx.notify();
    cx.spawn(async (cx) => {
      const r = await createIssue(place, { title, body: f.body.value(), labels: [...f.labels] });
      f.creating = false;
      if (r.error) { f.error = r.error; cx.notify(); return; }
      notify({ title: `Created issue #${r.number}`, level: "success", timeout: 3000 });
      for (const k of [...this.cache.keys()]) if (k.startsWith(`${this.pkey()}|issues|`)) this.cache.delete(k);
      this.toList();
      this.openDetail({ kind: "issue", repo: place.repo, number: r.number, stub: { number: r.number, title, url: r.url } }, cx);
    });
  }

  // The text an agent gets for what's open.
  promptFor(d, item) {
    const p = settingsNow().prompts;
    const hint = d.kind === "issue" && !this.place?.on ? closeHint(appHome(), d.repo, d.number) : "";
    if (d.project) return projectPrompt(p.project, d.project, { ...d.item, ...(item ?? {}), status: d.item.status, type: d.item.type, repo: d.repo }, hint);
    return d.kind === "pr" ? prPrompt(p.pr, d.repo, item) : issuePrompt(p.issue, d.repo, item, hint);
  }

  // Pastes the prompt into the tab's agent and presses Enter (hc send), then shows it.
  sendToAgent(agent, text, what, cx) {
    if (!agent || this.sending) return;
    this.sending = true; cx.notify();
    cx.spawn(async (cx) => {
      const r = await hc(["send", agent.address, text]).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
      this.sending = false;
      if (r.code === 0) {
        notify({ title: `Sent ${what} to ${agent.program?.name ?? "agent"}`, level: "success", timeout: 3000 });
        run("pane.focus", { terminal: agent.address });
      } else {
        const why = r.stderr?.trim().split("\n")[0] || "hc send failed";
        notify({ title: "Could not send to the agent", body: agent.status === "blocked" ? "It is waiting for an answer. Reply to it first." : why, level: "error" });
      }
      cx.notify();
    });
  }

  // A new tab in the same space, in the repo, with the first installed agent and the prompt as its task.
  newAgentTab(ctx, text, name, cx) {
    const place = this.place;
    if (this.sending) return;
    this.sending = true; cx.notify();
    cx.spawn(async (cx) => {
      const list = await knownAgents({ on: place.on }).catch(() => []);
      const agent = list.find((a) => a.installed);
      this.sending = false;
      if (!agent) notify({ title: "No agent installed", body: "Herdr found no installed agent to start.", level: "error" });
      else run("tab.new", { space: ctx?.space, folder: place.root, argv: agent.run, task: text, name });
      cx.notify();
    });
  }

  // ---- drawing ------------------------------------------------------------------

  render(cx) {
    if (this.dialog) return this.dialogView(theme());
    const changed = shared(CHANGED);
    if (changed && changed.at !== this.changedAt) { this.changedAt = changed.at; this.invalidate(changed.repo); }
    const ctx = context();
    const shown = isShown();
    const appearing = shown && !this.wasShown;
    if (shown) {
      this.checkHealth(ctx?.on ?? null, cx, appearing && this.health()?.ok === false ? 0 : Infinity);
      if (ctx && this.health()?.ok) this.resolve(ctx, cx);
    }
    if (shown) this.ensure(cx, appearing ? FRESH_MS : Infinity);
    this.wasShown = shown;

    const t = theme();
    const s = settingsNow();
    return v_flex().id(NAME).track_focus(this.handle).size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        if (this.view !== "list") { this.goBack(cx); cx.stop_propagation(); }
        else if (props()?.overlay) { this.closeWindow(); cx.stop_propagation(); }
      })
      .child(this.header(t, s))
      .child(this.view === "settings" ? this.settingsView(t)
        : !this.health() ? note(t, "Checking the GitHub CLI…")
        : !this.health().ok ? v_flex().flex_1().min_h(0).child(problem(t, "gh-health", { ...this.health(), retry: (cx) => this.recheck(cx) }))
        : this.view === "new" ? this.newView(t)
        : this.view === "detail" ? this.detailView(t, ctx)
        : this.listView(t, s));
  }

  header(t, s) {
    const place = this.place, d = this.detail;
    const sub = place?.repo ?? (place?.error ? (place.on ? `${place.on}: ` : "") + (place.cwd ?? "") : "");
    const title = this.view === "settings" ? "Settings" : this.view === "new" ? "New issue"
      : this.view === "detail" ? (d?.kind === "draft" ? "Draft item" : `${d?.kind === "pr" ? "PR" : "Issue"} #${d?.number ?? ""}`)
      : "GitHub";
    const url = this.pageUrl(s);
    return h_flex().h(42).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border)
      .when(this.view !== "list", (el) => el.child(iconButton(t, "gh-back", "chevron-left", "Back", (cx) => this.goBack(cx))))
      .when(this.view === "list", (el) => el.child(div().pl(4).pr(4).text_color(t.muted).child(svg(`${ICONS}/github.svg`).size(15))))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().font_semibold().line_height("16px").child(title))
        .child(div().truncate().text_size(11).line_height("14px").text_color(t.dim).child(sub)))
      .when(this.inflight.size > 0, (el) => el.child(div().text_size(11.5).text_color(t.dim).pr(4).child("Loading…")))
      .when(this.view === "list" && s.tab === "issues" && Boolean(place?.repo), (el) => el.child(iconButton(t, "gh-new", "plus", "New issue", (cx) => this.openNew(cx))))
      .when(Boolean(url), (el) => el.child(iconButton(t, "gh-web", "external", "Open on GitHub", (cx) => cx.open_url(url))))
      .when((this.view === "list" || this.view === "detail") && Boolean(place?.repo), (el) => el.child(iconButton(t, "gh-refresh", "refresh", "Refresh", (cx) => { this.checkHealth(this.healthOn, cx, 0); this.ensure(cx, 0); cx.notify(); })))
      .when(this.view === "list" || this.view === "detail", (el) => el.child(iconButton(t, "gh-settings", "settings", "Settings", (cx) => this.openSettings(cx))))
      .when(Boolean(props()?.overlay), (el) => el.child(iconButton(t, "gh-close", "close", "Close", () => this.closeWindow())));
  }

  // A failed read, with the command it names (if any) and a way to read again.
  errorBox(t, id, message) {
    return problem(t, id, { message, retry: (cx) => { this.checkHealth(this.healthOn, cx, 0); this.ensure(cx, 0); cx.notify(); }, retryLabel: "Refresh" });
  }

  // ---- list ---------------------------------------------------------------------

  listView(t, s) {
    const place = this.place;
    if (!place) return note(t, "Looking for the repository…");
    if (place.error) return note(t, place.error);
    const tabs = h_flex().flex_none().px(10).pt(8).gap(4)
      .children(TABS.map(([id, label]) => div().id(`gh-tab-${id}`).h(26).px(10).flex().items_center().rounded(6).cursor_pointer().text_size(12.5)
        .bg(s.tab === id ? t.selected : t.background).text_color(s.tab === id ? t.foreground : t.muted)
        .when(s.tab === id, (el) => el.font_medium())
        .hover((st) => st.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { setSettings({ tab: id }); this.ensure(cx, Infinity); })
        .child(label)));
    const filterBox = div().flex_none().px(10).pt(8)
      .child(div().id("gh-filter").h(30).px(10).flex().items_center().rounded(7).border_1().border_color(t.input).bg(t.surface)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(this.filter).w_full().text_size(12.5).text_color(t.foreground)));
    const body = s.tab === "project" ? this.projectList(t, s) : this.itemList(t, s);
    return v_flex().flex_1().min_h(0).child(tabs).child(filterBox).children(body);
  }

  stateChips(t, states, current, key) {
    return h_flex().flex_none().px(10).pt(8).gap(5).flex_wrap()
      .children(states.map((st) => chip(t, `gh-st-${key}-${st}`, STATE_LABEL[st], st === current, () => setSettings({ [key]: st }))));
  }

  // Issues or PRs: state chips, then the rows.
  itemList(t, s) {
    const prs = s.tab === "prs";
    const chips = prs ? this.stateChips(t, PR_STATES, s.prState, "prState") : this.stateChips(t, ISSUE_STATES, s.issueState, "issueState");
    const hit = this.cache.get(prs ? this.prsKey(s) : this.issuesKey(s));
    const what = prs ? "pull requests" : "issues";
    if (!hit) return [chips, note(t, `Loading ${what}…`)];
    if (hit.error) return [chips, this.errorBox(t, "gh-err-list", hit.error)];
    const shown = hit.items.filter((i) => matches(i, this.filter.value()));
    if (!hit.items.length) return [chips, note(t, `No ${what} here.`)];
    if (!shown.length) return [chips, note(t, `No ${what} match the filter.`)];
    const repo = this.place.repo;
    return [chips, div().id(`gh-${s.tab}`).flex_1().min_h(0).overflow_y_scrollbar().px(6).pt(4).pb(6)
      .children(shown.map((i) => this.row(t, `gh-r-${s.tab}-${i.number}`, i, prs ? `#${i.number} · ${i.headRefName ?? ""}` : `#${i.number}`,
        (cx) => this.openDetail({ kind: prs ? "pr" : "issue", repo, number: i.number, stub: i }, cx)))) ];
  }

  row(t, id, i, lead, open, extra = null) {
    const [stateText, stateColor] = stateLook(t, i);
    const showState = i.state && i.state !== "OPEN" || i.isDraft;
    return v_flex().id(id).flex_none().px(10).py(7).gap(3).rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => open(cx))
      .child(div().w_full().text_size(13).child(i.title))
      .child(h_flex().w_full().gap(6).items_center().flex_wrap().text_size(11).text_color(t.dim)
        .when(Boolean(showState), (el) => el.child(badge(t, stateText, stateColor)))
        .when(Boolean(extra), (el) => el.child(extra))
        .child([lead, i.author?.login, i.updatedAt ? ago(i.updatedAt) : null].filter(Boolean).join(" · "))
        .children(labelChips(t, i.labels, id)));
  }

  // The project: a picker when several are linked, status chips, then items grouped by status.
  projectList(t, s) {
    if (!canReadProjects(this.health())) {
      return [problem(t, "gh-scope", {
        message: "The Project tab needs gh's read:project scope. Run this in a terminal, follow its steps, then check again.",
        command: PROJECT_SCOPE_COMMAND, retry: (cx) => this.recheck(cx),
      })];
    }
    const linked = this.cache.get(this.projectsKey());
    if (!linked) return [note(t, "Looking for linked projects…")];
    if (linked.error) return [this.errorBox(t, "gh-err-projects", linked.error)];
    if (!linked.items.length) return [note(t, "No open GitHub Project is linked to this repository. Link one from the repository's Projects tab on GitHub.")];
    const p = this.currentProject(s);
    const picker = linked.items.length > 1 ? h_flex().flex_none().px(10).pt(8).gap(5).flex_wrap()
      .children(linked.items.map((x) => chip(t, `gh-proj-${x.number}`, x.title, x.id === p.id,
        () => setSettings({ projects: { ...s.projects, [this.place.repo]: x.id } })))) : null;
    const hit = this.cache.get(this.projectKey(p.id));
    const head = picker ? [picker] : [];
    if (!hit) return [...head, note(t, `Loading ${p.title}…`)];
    if (hit.error) return [...head, this.errorBox(t, "gh-err-project", hit.error)];
    const options = [...hit.project.statuses, ...(hit.items.some((i) => i.status === NO_STATUS) ? [{ name: NO_STATUS, color: "GRAY" }] : [])];
    const hidden = new Set(s.hidden[p.id] ?? options.filter((o) => /^done$/i.test(o.name)).map((o) => o.name));
    const toggle = (name) => {
      const next = new Set(hidden);
      next.has(name) ? next.delete(name) : next.add(name);
      setSettings({ hidden: { ...s.hidden, [p.id]: [...next] } });
    };
    const chips = h_flex().flex_none().px(10).pt(8).gap(5).flex_wrap()
      .child(chip(t, "gh-ps-all", "All", hidden.size === 0, () => setSettings({ hidden: { ...s.hidden, [p.id]: [] } })))
      .children(options.map((o, k) => chip(t, `gh-ps-${k}`, o.name, !hidden.has(o.name), () => toggle(o.name), optionColor(t, o.color))));
    const f = this.filter.value();
    const groups = options.filter((o) => !hidden.has(o.name))
      .map((o) => [o, hit.items.filter((i) => i.status === o.name && matches(i, f))])
      .filter(([, items]) => items.length);
    const project = { title: hit.project.title, url: hit.project.url };
    const list = !groups.length ? note(t, hit.items.length ? "No items match these filters." : "This project has no items.")
      : div().id("gh-project").flex_1().min_h(0).overflow_y_scrollbar().px(6).pt(4).pb(6)
        .children(groups.flatMap(([o, items], g) => [
          h_flex().id(`gh-pg-${g}`).flex_none().px(10).pt(10).pb(4).gap(6).items_center().text_size(11.5).font_semibold().text_color(t.muted)
            .child(div().size(8).rounded(4).bg(optionColor(t, o.color)))
            .child(`${o.name}`).child(div().font_normal().text_color(t.dim).child(String(items.length))),
          ...items.map((i, k) => this.row(t, `gh-pi-${g}-${k}`, i,
            i.type === "DRAFT_ISSUE" ? "Draft" : `${i.repo === this.place.repo ? "" : i.repo}#${i.number}`,
            (cx) => this.openDetail({
              kind: i.type === "DRAFT_ISSUE" ? "draft" : i.type === "PULL_REQUEST" ? "pr" : "issue",
              repo: i.repo, number: i.number, stub: i, item: i, project }, cx),
            i.assignees?.length ? div().child(i.assignees.map((a) => `@${a}`).join(" ")) : null)),
        ]));
    return [...head, chips, list];
  }

  // ---- detail -------------------------------------------------------------------

  detailView(t, ctx) {
    const d = this.detail;
    if (!d) return note(t, "Nothing open.");
    const hit = d.kind === "draft" ? { item: d.item } : this.cache.get(this.detailKey(d));
    const item = hit?.item ?? d.stub;
    const loaded = Boolean(hit?.item);
    const [stateText, stateColor] = stateLook(t, item);
    const comments = loaded && Array.isArray(item.comments) ? item.comments : [];
    const doc = div().id("gh-detail").flex_1().min_h(0).overflow_y_scrollbar()
      .child(v_flex().w_full().px(16).pt(14).pb(16).gap(10)
        .when(Boolean(hit?.error), (el) => el.child(this.errorBox(t, "gh-err-detail", hit.error)))
        .when(Boolean(d.project), (el) => el.child(h_flex().gap(6).items_center().flex_wrap().text_size(11.5).text_color(t.dim)
          .child(svg(`${ICONS}/project.svg`).size(12)).child(`${d.project.title} · ${d.item.status}`)))
        .child(div().w_full().text_size(16).font_semibold().child(item.title))
        .child(h_flex().w_full().gap(6).items_center().flex_wrap().text_size(11.5).text_color(t.dim)
          .when(Boolean(stateText), (el) => el.child(badge(t, stateText, stateColor)))
          .when(d.kind !== "draft", (el) => el.child(`${d.repo}#${d.number}`))
          .when(Boolean(item.author?.login), (el) => el.child(`${item.author.login}${item.createdAt ? ` · opened ${ago(item.createdAt)} ago` : ""}`))
          .children(labelChips(t, item.labels, "gh-d")))
        .when(d.kind === "pr" && loaded, (el) => el.child(h_flex().w_full().gap(8).items_center().flex_wrap().text_size(11.5).text_color(t.dim)
          .child(div().font_family(settings().font_family).child(`${item.headRefName} → ${item.baseRefName}`))
          .child(div().text_color(t.ansi2).child(`+${item.additions ?? 0}`))
          .child(div().text_color(t.ansi1).child(`−${item.deletions ?? 0}`))
          .child(`${item.changedFiles ?? 0} file${item.changedFiles === 1 ? "" : "s"}`)
          .when(Boolean(item.reviewDecision), (e) => e.child(item.reviewDecision.replaceAll("_", " ").toLowerCase()))))
        .child(!loaded && d.kind !== "draft"
          ? div().text_color(t.dim).child(hit?.error ? "" : "Reading…")
          : div().w_full().pt(4).text_size(13.5).child(TextView.markdown("gh-body", item.body?.trim() || "_No description._")))
        .when(comments.length > 0, (el) => el
          .child(div().pt(8).text_size(12).font_semibold().text_color(t.muted).child(`${comments.length} comment${comments.length === 1 ? "" : "s"}`))
          .children(comments.map((c, i) => v_flex().w_full().gap(4).p(10).rounded(8).border_1().border_color(t.border)
            .child(div().text_size(11.5).text_color(t.dim).child(`${c.author?.login ?? "?"} · ${ago(c.createdAt)} ago`))
            .child(div().w_full().text_size(13).child(TextView.markdown(`gh-c-${i}`, c.body?.trim() || "")))))));
    // Drafts send what the project knows; issues and PRs need their URL first.
    const ready = d.kind === "draft" || Boolean(item.url);
    const text = ready ? this.promptFor(d, item) : "";
    const what = d.kind === "draft" ? "the draft item" : `#${d.number}`;
    const agent = ctx ? agentIn(ctx.tab) : null;
    const page = d.kind === "draft" ? itemUrl(d.project, d.item) : item.url;
    const closable = d.kind === "issue" && loaded && item.state === "OPEN";
    const actions = h_flex().flex_none().px(14).py(10).gap(8).items_center().flex_wrap().border_t(1).border_color(t.border)
      .child(pill(t, "gh-send", this.sending ? "Sending…" : agent ? `Send to ${agent.program?.name ?? "agent"}` : "No agent in this tab",
        (cx) => this.sendToAgent(agent, text, what, cx), { strong: true, disabled: !agent || this.sending || !ready }))
      .child(pill(t, "gh-newtab", "New agent tab", (cx) => this.newAgentTab(ctx, text, d.kind === "draft" ? "Draft" : `#${d.number}`, cx),
        { disabled: this.sending || !ready }))
      .child(pill(t, "gh-open", "Open on GitHub", (cx) => cx.open_url(page), { disabled: !page }))
      .when(closable, (el) => el.child(pill(t, "gh-close-issue", "Close issue", () => this.openCloseDialog(d, item))));
    return v_flex().flex_1().min_h(0).child(doc).child(actions);
  }

  // ---- new issue ----------------------------------------------------------------

  newView(t) {
    const f = this.form;
    if (!f) return note(t, "");
    const labels = this.cache.get(this.labelsKey());
    const field = (id, el) => div().id(id).w_full().rounded(6).border_1().border_color(t.input).bg(t.surface)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(el);
    const labelPicker = !labels ? div().text_size(12).text_color(t.dim).child("Loading labels…")
      : labels.error ? div().text_size(12).text_color(t.ansi1).child(labels.error)
      : !labels.items.length ? div().text_size(12).text_color(t.dim).child("This repository has no labels.")
      : h_flex().w_full().gap(5).flex_wrap().children(labels.items.map((l, i) => chip(t, `gh-nl-${i}`, l.name, f.labels.has(l.name),
        (cx) => { f.labels.has(l.name) ? f.labels.delete(l.name) : f.labels.add(l.name); cx.notify(); }, `#${l.color || "888888"}`)));
    const title = f.title.value().trim();
    return v_flex().flex_1().min_h(0)
      .child(div().id("gh-new-scroll").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().w_full().p(16).gap(8)
          .child(div().text_size(12).font_semibold().text_color(t.muted).child("Title"))
          .child(field("gh-new-title", div().h(32).px(10).flex().items_center().child(Input.new(f.title).w_full().text_size(13).text_color(t.foreground))))
          .child(div().pt(6).text_size(12).font_semibold().text_color(t.muted).child("Description"))
          .child(field("gh-new-body", Textarea.new(f.body).w_full().px(8).py(6).text_size(13).text_color(t.foreground)))
          .child(div().pt(6).text_size(12).font_semibold().text_color(t.muted).child(`Labels${f.labels.size ? ` (${f.labels.size})` : ""}`))
          .child(labelPicker)
          .when(Boolean(f.error), (el) => el.child(div().pt(4).text_size(12).text_color(t.ansi1).child(f.error)))))
      .child(h_flex().flex_none().px(14).py(10).gap(8).items_center().border_t(1).border_color(t.border)
        .child(pill(t, "gh-create", f.creating ? "Creating…" : "Create issue", (cx) => this.createIssue(cx), { strong: true, disabled: !title || f.creating }))
        .child(pill(t, "gh-cancel-new", "Cancel", (cx) => this.goBack(cx))));
  }

  // ---- settings -----------------------------------------------------------------

  settingsView(t) {
    const box = (kind, label, hint) => v_flex().w_full().gap(6)
      .child(h_flex().w_full().items_center()
        .child(div().flex_1().font_semibold().child(label))
        .child(div().id(`gh-reset-${kind}`).text_size(11.5).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { this.prompts[kind].set_value(DEFAULT_PROMPTS[kind]); cx.notify(); }).child("Reset")))
      .child(div().text_size(11.5).text_color(t.dim).child(hint))
      .child(div().id(`gh-prompt-${kind}`).w_full().rounded(6).border_1().border_color(t.input).bg(t.surface)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Textarea.new(this.prompts[kind]).w_full().px(8).py(6).text_size(13).text_color(t.foreground)));
    return v_flex().flex_1().min_h(0)
      .child(div().id("gh-settings-scroll").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().w_full().p(16).gap(16)
          .child(div().text_size(12).text_color(t.dim).child("What an agent gets before the reference to what you send it."))
          .child(box("issue", "Issue prompt", "Followed by repo#number, title and link."))
          .child(box("pr", "Pull request prompt", "Followed by repo#number, title and link."))
          .child(box("project", "Project item prompt", "Followed by the project, the item's status and the item: its link, or a draft's text."))))
      .child(h_flex().flex_none().px(14).py(10).gap(8).items_center().border_t(1).border_color(t.border)
        .child(pill(t, "gh-save", "Save", (cx) => this.saveSettings(cx), { strong: true }))
        .child(pill(t, "gh-cancel", "Cancel", (cx) => this.closeSettings(cx))));
  }
}
