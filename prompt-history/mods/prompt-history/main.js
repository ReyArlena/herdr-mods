// Prompt History: every prompt you gave a Claude Code agent this session, and what it
// answered, as cards.
//
// As a panel it follows the Claude Code agent in the focused tab and shows that agent's
// current session. Click a card to read the whole turn in the panel; the expand button on
// a hovered card opens it in a dialog (this same mod, with props { overlay, file, turn }).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, TextView } from "gpui-base";
import { agents, closeOverlay, exec, focused, layout, openOverlay, props, run, settings, theme, watchFolder } from "herdr";
import { sessionFor, loadTurns, excerpt, duration, clock } from "./transcript.js";

const NAME = "prompt-history";
const ICONS = `mods/${NAME}/icons`;
const TICK_MS = 1500;     // how often to check which agent to follow
const RESOLVE_EVERY = 4;  // ticks between re-reading the session (catches /clear and resume)
const CARD_H = 152;      // every card is this tall, so the list can place them by number
const ROW_H = CARD_H + 8; // a card and the gap under it
const LIST_PAD = 8;      // space above the first card
const REFRESH_MS = 700;  // the refresh icon turns at least this long, so a fast reload still shows
// Shows the "install jq" screen whatever the check says, to look at it.
const PREVIEW_JQ_SCREEN = false;
const LINE = 18;          // card text line height; cards show two lines of each side

const stop = (_e, cx) => cx.stop_propagation();

const iconButton = (t, id, icon, tip, action) =>
  div().id(id).p(4).rounded(6).flex_none().cursor_pointer().text_color(t.muted).tooltip(tip)
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_mouse_down("left", stop)
    .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
    .child(svg(`${ICONS}/${icon}.svg`).size(14));

const spinner = (t, size = 12) => svg(`${ICONS}/spinner.svg`).size(size).flex_none().text_color(t.working).spin(900);
const note = (t, text) => div().p(16).text_size(12.5).text_color(t.dim).child(text);

const claudeAgents = () => agents().filter((a) => a.app === "claude-code");
const newest = (list) => [...list].sort((a, b) => b.seq - a.seq)[0];

// The path from the layout root to the block holding this mod.
function pathTo(node, path = []) {
  if (!node) return null;
  const here = [...path, node];
  if (node.content?.mod === NAME) return here;
  for (const k of [...(node.children ?? []), ...(node.floating ?? [])]) {
    const hit = pathTo(k, here);
    if (hit) return hit;
  }
  return null;
}

export default class PromptHistory extends View {
  init(_props, cx) {
    this.turns = [];
    this.session = null;   // { pid, id, file, dir }
    this.address = null;   // the agent terminal followed
    this.selected = null;  // turn id shown in the panel
    this.stick = true;     // keep the newest card in view, like a terminal
    this.offset = 0;       // how far the card list is scrolled, in px from the top
    this.viewH = 0;        // the card list's height, from its last layout
    this.hover = null;     // the card under the pointer, which shows its expand button
    this.jq = null;        // jq found: null until checked
    this.inputOpen = new Set(); // turns whose input is expanded in the detail view
    this.gen = 0;
    this.misses = 0;       // failed session reads in a row
    this.ticks = 0;

    const p = props() ?? {};
    if (p.overlay && p.turn) {
      this.dialog = { id: p.overlay, turn: p.turn, address: p.address };
      if (p.file) this.follow(cx, { file: p.file, dir: p.file.slice(0, p.file.lastIndexOf("/")) });
      return;
    }
    this.checkJq(cx);
    this.search = InputState.new({ placeholder: "Search…" });
    this.search.on("change", (_e, cx) => cx.notify());
    cx.timer.every(TICK_MS, (cx) => this.tick(cx));
    this.tick(cx);
  }

  // jq trims transcripts down to what the cards need; without it long sessions lose turns.
  checkJq(cx) {
    cx.spawn(async (cx) => {
      const r = await exec("jq", ["--version"]).catch(() => null);
      this.jq = r?.code === 0;
      cx.notify();
    });
  }

  refresh(cx) {
    this.refreshing = true;
    this.tick(cx, true);
    cx.timer.after(REFRESH_MS, (cx) => { this.refreshing = false; cx.notify(); });
    cx.notify();
  }

  // Follows the Claude Code agent of the focused tab, else keeps the one it had.
  pickAgent() {
    const list = claudeAgents();
    const f = focused();
    return list.find((a) => a.address === f?.agent || a.address === f?.terminal)
      ?? newest(list.filter((a) => a.tab === f?.tab))
      ?? list.find((a) => a.address === this.address)
      ?? newest(list.filter((a) => a.space === f?.space))
      ?? newest(list);
  }

  tick(cx, force = false) {
    const address = this.pickAgent()?.address ?? null;
    const changed = address !== this.address;
    if (!changed && !force && ++this.ticks % RESOLVE_EVERY !== 0) return;
    if (changed) { this.stick = true; this.misses = 0; this.address = address; this.selected = null; this.ticks = 0; this.session = null; this.turns = []; this.gen++; cx.notify(); }
    cx.spawn(async (cx) => {
      const s = address ? await sessionFor(address).catch(() => null) : null;
      if (address !== this.address) return;
      if (s && s.file === this.session?.file && !force) return;
      if (!s) {
        // Claude Code rewrites its session file often: one failed read while it does
        // isn't a lost session. Keep the cards unless it stays gone.
        if (this.session && ++this.misses < 3) return;
        this.session = null; this.turns = []; this.gen++; this.missing = Boolean(address); cx.notify(); return;
      }
      this.misses = 0;
      this.missing = false;
      // A new session in the same terminal (/clear, resume) starts the cards over.
      if (s.file !== this.session?.file) this.selected = null;
      this.follow(cx, s);
    });
  }

  // Loads a transcript and reloads it whenever its folder changes.
  follow(cx, session) {
    this.session = session;
    const gen = ++this.gen;
    cx.spawn(async (cx) => {
      for (;;) {
        this.turns = await loadTurns(session.file).catch(() => this.turns);
        if (gen !== this.gen) return;
        cx.notify();
        try { await watchFolder(session.dir); } catch { return; }
        if (gen !== this.gen) return;
      }
    });
  }

  // working: the last turn is unfinished and its agent hasn't stopped. An unfinished
  // turn on a stopped agent was interrupted.
  isWorking(turn) {
    if (turn.done || turn !== this.turns[this.turns.length - 1]) return false;
    const address = this.dialog?.address ?? this.address;
    const a = agents().find((x) => x.address === address);
    return !a || a.status === "working" || a.status === "blocked";
  }

  openDialog(turn) {
    openOverlay({
      mod: NAME, kind: "dialog", width: 0.7, height: 0.85,
      props: { file: this.session?.file, turn: turn.id, address: this.address },
    });
  }

  // A window closes. In a stack of panels (the tab bar's Files, Changes, GitHub...) the
  // panel column hides, as its tab button does; a block on its own hides itself.
  hidePanel() {
    const overlay = props()?.overlay;
    if (overlay) { closeOverlay(overlay); return; }
    const path = pathTo(layout());
    if (!path) return;
    const i = path.findIndex((n) => n.type === "stack");
    const target = i > 0 ? path[i - 1] : path[path.length - 1];
    if (target?.id) run("layout.hide", { id: target.id });
  }

  render(cx) {
    const t = theme();
    if (this.dialog) return this.renderDialog(t);
    const turn = this.selected && this.turns.find((x) => x.id === this.selected);
    return v_flex().id(NAME).size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.selected) { this.selected = null; cx.notify(); cx.stop_propagation(); }
      })
      .child(this.header(t, turn))
      .children(this.jq === false || PREVIEW_JQ_SCREEN ? [this.jqScreen(t)] : turn ? [this.page(t, turn, "ph-page")] : this.listView(t));
  }

  header(t, turn) {
    const a = agents().find((x) => x.address === this.address);
    const sub = turn ? clock(turn.started) : a ? `${a.tab_name || a.title} · ${this.turns.length} prompt${this.turns.length === 1 ? "" : "s"}` : "No Claude Code agent";
    const working = this.turns.some((x) => this.isWorking(x));
    return h_flex().h(42).flex_none().pl(10).pr(8).gap(4).items_center().border_b(1).border_color(t.border)
      .when(Boolean(turn), (el) => el.child(iconButton(t, "ph-back", "chevron-left", "Back", (cx) => { this.selected = null; cx.notify(); })))
      .when(!turn, (el) => el.child(div().pl(4).pr(4).text_color(t.muted).child(svg(`${ICONS}/history.svg`).size(15))))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().font_semibold().line_height("16px").child(turn ? "Turn" : "Prompt History"))
        .child(div().truncate().text_size(11).line_height("14px").text_color(t.dim).child(sub)))
      .when(working, (el) => el.child(div().pr(4).child(spinner(t))))
      .when(Boolean(turn), (el) => el.child(iconButton(t, "ph-expand", "expand", "Open in a dialog", () => this.openDialog(turn))))
      .when(!turn, (el) => el.child(this.refreshButton(t)))
      .child(iconButton(t, "ph-close", "close", "Close", () => this.hidePanel()));
  }

  refreshButton(t) {
    const icon = svg(`${ICONS}/refresh.svg`).size(14);
    return div().id("ph-refresh").p(4).rounded(6).flex_none().cursor_pointer().tooltip("Reload this session")
      .text_color(this.refreshing ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop)
      .on_click((_e, cx) => { cx.stop_propagation(); this.refresh(cx); })
      .child(this.refreshing ? icon.spin(REFRESH_MS) : icon);
  }

  // Shown instead of the cards when jq is missing.
  jqScreen(t) {
    const mono = settings().font_family;
    const cmd = (c) => div().font_family(mono).text_size(12).text_color(t.foreground).child(c);
    return v_flex().id("ph-jq").flex_1().min_h(0).overflow_y_scrollbar().items_center().justify_center().px(24).py(20).gap(14)
      .child(div().size(44).rounded(12).flex().items_center().justify_center().bg(t.raised).border_1().border_color(t.border)
        .font_family(mono).font_semibold().text_size(15).text_color(t.accent).child("jq"))
      .child(div().font_semibold().text_size(14).child("Install jq to use Prompt History"))
      .child(div().max_w(300).whitespace_normal().text_center().text_size(12.5).line_height("19px").text_color(t.muted)
        .child("Claude Code's session files grow to megabytes of tool output. jq trims them to just your prompts and Claude's answers, so the newest cards always load."))
      .child(v_flex().w_full().max_w(300).gap(6).px(14).py(10).rounded(8).border_1().border_color(t.border).bg(t.surface)
        .child(cmd("sudo pacman -S jq"))
        .child(cmd("sudo apt install jq"))
        .child(cmd("brew install jq")))
      .child(div().id("ph-jq-again").h(32).px(14).flex().items_center().rounded(8).cursor_pointer()
        .bg(t.solid).text_color(t.solid_foreground).text_size(12).font_medium()
        .hover((s) => s.opacity(0.88))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => { this.jq = null; this.checkJq(cx); cx.notify(); })
        .child(this.jq === null ? "Checking…" : "Check again"));
  }

  listView(t) {
    const searchBox = div().flex_none().px(10).pt(10)
      .child(div().id("ph-search").h(32).px(10).flex().items_center().rounded(8).border_1().border_color(t.border)
        .on_mouse_down("left", stop)
        .on_key_down((e, cx) => {
          if (e.key !== "escape" || !this.search.value()) return;
          this.search.set_value("");
          cx.stop_propagation();
          cx.notify();
        })
        .child(Input.new(this.search).w_full().h_full().text_size(12.5).text_color(t.foreground)));
    if (this.jq === null) return [searchBox, note(t, "Checking for jq…")];
    if (!this.address) return [searchBox, note(t, "No Claude Code agent in this tab.")];
    if (!this.session) return [searchBox, note(t, this.missing ? "Couldn't find this agent's Claude Code session." : "Looking for this agent's session…")];
    if (!this.turns.length) return [searchBox, note(t, "No prompts in this session yet.")];
    const q = this.search.value().trim().toLowerCase();
    const shown = this.turns.filter((x) => !q || x.prompt.toLowerCase().includes(q) || x.answer.toLowerCase().includes(q));
    if (!shown.length) return [searchBox, note(t, "No prompts match the search.")];

    // Like a terminal: oldest at the top, newest at the bottom, held there while the view
    // sits at the bottom. The list scrolls by hand (a clipped area, cards placed by their
    // fixed height) so the mod always knows where it is: gpui's own scroll areas can't be
    // moved from a mod, and its virtual lists can't hold per-card hover buttons.
    const total = LIST_PAD + shown.length * ROW_H;
    const max = Math.max(0, total - this.viewH);
    this.offset = this.stick ? max : Math.min(Math.max(0, this.offset), max);
    const first = Math.max(0, Math.floor((this.offset - LIST_PAD) / ROW_H));
    const last = Math.min(shown.length, Math.ceil((this.offset + this.viewH) / ROW_H) + 1);
    const cards = this.viewH ? shown.slice(first, last).map((x, k) =>
      div().absolute().left(10).right(14).top(LIST_PAD + (first + k) * ROW_H - this.offset).h(CARD_H).child(this.card(t, x))) : [];
    const thumbH = this.viewH && total > this.viewH ? Math.max(24, this.viewH * this.viewH / total) : 0;
    const area = div().id("ph-list").relative().flex_1().min_h(0).w_full().overflow_hidden()
      .on_size_change((size, cx) => { if (size.height !== this.viewH) { this.viewH = size.height; cx.notify(); } })
      .on_scroll_wheel((e, cx) => {
        const dy = e.delta?.y ?? 0;
        if (!dy) return;
        this.offset = Math.min(Math.max(0, this.offset - dy), max);
        this.stick = this.offset >= max - 1;
        cx.stop_propagation();
        cx.notify();
      })
      .children(cards)
      .when(thumbH > 0, (el) => el.child(div().absolute().right(4).w(4).rounded(2).bg(t.border)
        .h(thumbH).top((this.viewH - thumbH) * (max ? this.offset / max : 1))))
      .when(!this.stick, (el) => el.child(this.jumpButton(t)));
    return [searchBox, area];
  }

  jumpButton(t) {
    return h_flex().absolute().bottom(14).left(0).right(0).justify_center()
      .child(h_flex().id("ph-jump").h(28).px(12).gap(6).items_center().rounded(14).cursor_pointer()
        .bg(t.solid).text_color(t.solid_foreground).text_size(12).font_medium().shadow_md()
        .hover((s) => s.opacity(0.9))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => { cx.stop_propagation(); this.stick = true; cx.notify(); })
        .child(svg(`${ICONS}/chevron-down.svg`).size(13))
        .child("Jump to present"));
  }

  // Two lines of text at most: a fixed line height, a two-line cap, and a cut so it ends in an ellipsis.
  clamp(t, text, color) {
    return div().w_full().whitespace_normal().text_size(12.5).line_height(`${LINE}px`).h(LINE * 2).flex_none().overflow_hidden()
      .text_color(color).child(excerpt(text, 120));
  }

  // A card: Input over Output, split by a line. Hovering shows an expand button that opens
  // the turn in a dialog; a click anywhere else opens it in the panel.
  card(t, turn) {
    const id = turn.id;
    const working = this.isWorking(turn);
    const labelRow = (label, color, rest) => h_flex().h(16).gap(6).items_center().text_size(11).text_color(t.dim)
      .child(div().font_medium().text_color(color).child(label)).child(rest);
    const input = v_flex().h(74).px(12).pt(10).gap(4)
      .child(labelRow("Input", t.accent, div().child(clock(turn.started))))
      .child(this.clamp(t, turn.prompt, t.foreground));
    const output = v_flex().flex_1().px(12).pt(10).gap(4).border_t_1().border_color(t.border)
      .child(working ? this.workingRow(t) : this.doneRow(t, turn))
      .when(Boolean(turn.answer), (el) => el.child(this.clamp(t, turn.answer, working ? t.dim : t.muted)));
    return v_flex().id(`ph-card-${id}`).relative().size_full().rounded(10).border_1().overflow_hidden()
      .border_color(working ? t.working : t.border).bg(t.surface).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_hover((h, cx) => { this.hover = h ? id : this.hover === id ? null : this.hover; cx.notify(); })
      .on_click((_e, cx) => { this.selected = id; this.hover = null; cx.notify(); })
      .child(input)
      .child(output)
      .when(this.hover === id, (el) => el.child(div().absolute().top(6).right(6).rounded(6).bg(t.popover).border_1().border_color(t.border)
        .child(iconButton(t, `ph-open-${id}`, "expand", "Open in a dialog", () => this.openDialog(turn)))));
  }

  workingRow(t) {
    return h_flex().h(16).gap(6).items_center().text_size(11)
      .child(div().font_medium().text_color(t.ansi2).child("Output"))
      .child(spinner(t, 11))
      .child(div().text_color(t.working).loop("opacity", { from: 0.45, to: 1, period: 1200 }).child("Working..."));
  }

  doneRow(t, turn) {
    const bits = [turn.interrupted ? "Interrupted" : "", duration(turn.durationMs),
      turn.tools ? `${turn.tools} tool${turn.tools === 1 ? "" : "s"}` : ""].filter(Boolean);
    return h_flex().h(16).gap(6).items_center().text_size(11).text_color(t.dim)
      .child(div().font_medium().text_color(t.ansi2).child("Output"))
      .child(div().text_color(turn.interrupted ? t.blocked : t.dim).child(bits.join(" · ")));
  }

  // The detail view, in the panel and the dialog alike: an Input card, collapsed to two
  // lines until opened, and an Output card.
  page(t, turn, id) {
    const working = this.isWorking(turn);
    const open = this.inputOpen.has(turn.id);
    const toggle = (cx) => { open ? this.inputOpen.delete(turn.id) : this.inputOpen.add(turn.id); cx.notify(); };
    const input = this.section(t, `${id}-in`, {
      label: "Input", color: t.accent, meta: clock(turn.started),
      trailing: svg(`${ICONS}/${open ? "chevron-down" : "chevron-right"}.svg`).size(14).text_color(t.muted),
      onHeader: toggle,
      body: open ? markdown(`${id}-in-${turn.id}`, turn.prompt) : this.clamp(t, turn.prompt, t.muted),
    });
    const bits = [turn.interrupted ? "Interrupted" : "", duration(turn.durationMs),
      turn.tools ? `${turn.tools} tool${turn.tools === 1 ? "" : "s"}` : ""].filter(Boolean);
    const output = this.section(t, `${id}-out`, {
      label: "Output", color: t.ansi2,
      meta: working ? null : bits.join(" · "),
      trailing: working ? h_flex().gap(6).items_center().text_size(11.5)
        .child(spinner(t, 11))
        .child(div().text_color(t.working).loop("opacity", { from: 0.45, to: 1, period: 1200 }).child("Working...")) : null,
      body: turn.answer ? div().w_full().when(working, (el) => el.opacity(0.7)).child(markdown(`${id}-out-${turn.id}`, turn.answer))
        : div().text_size(12.5).text_color(t.dim).child(working ? "Waiting for the first words…" : turn.interrupted ? "Interrupted before an answer." : "No answer text."),
    });
    return div().id(`${id}-scroll`).flex_1().min_h(0).overflow_y_scrollbar()
      .child(v_flex().w_full().p(12).gap(12).child(input).child(output));
  }

  // A card with a coloured edge and label; the header toggles it when onHeader is given.
  section(t, id, { label, color, meta, trailing, onHeader, body }) {
    const header = h_flex().id(`${id}-head`).px(14).py(10).gap(8).items_center()
      .when(Boolean(onHeader), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onHeader(cx)))
      .child(div().size(8).rounded(4).flex_none().bg(color))
      .child(div().font_semibold().text_size(12).text_color(color).child(label))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(meta ?? ""))
      .when(Boolean(trailing), (el) => el.child(trailing));
    // The colour is the card's own rounded background, showing in a 3px band above the
    // content: gpui clips children to a rectangle, so a child strip would poke past the
    // rounded corners.
    return v_flex().id(id).w_full().flex_none().rounded(10).border_1().border_color(t.border).bg(color)
      .child(v_flex().w_full().mt(3).rounded_b(9).bg(t.surface)
        .child(header)
        .child(div().w_full().px(14).pt(2).pb(12).child(body)));
  }

  renderDialog(t) {
    const turn = this.turns.find((x) => x.id === this.dialog.turn);
    const header = h_flex().h(42).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border)
      .child(div().pl(4).pr(4).text_color(t.muted).child(svg(`${ICONS}/history.svg`).size(15)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().font_semibold().line_height("16px").child("Prompt History"))
        .child(div().truncate().text_size(11).line_height("14px").text_color(t.dim).child(turn ? clock(turn.started) : "")))
      .when(Boolean(turn && this.isWorking(turn)), (el) => el.child(div().pr(4).child(spinner(t))))
      .child(iconButton(t, "ph-close", "close", "Close", () => closeOverlay(this.dialog.id)));
    return v_flex().id("ph-dialog").size_full().bg(t.background).text_color(t.foreground).text_size(13)
      .child(header).child(turn ? this.page(t, turn, "ph-dlg") : note(t, "Loading…"));
  }
}

const markdown = (id, text) => div().w_full().text_size(13.5).child(TextView.markdown(id, text).selectable(true));
