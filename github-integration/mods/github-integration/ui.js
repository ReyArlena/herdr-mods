// Small pieces of UI the views share. Theme colors only, so it follows any theme.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { notify, settings } from "herdr";

export const ICONS = "mods/github-integration/icons";

const stop = (_e, cx) => cx.stop_propagation();

// An icon button for headers. Stops the press so a window or drag block doesn't take it.
export const iconButton = (t, id, icon, tip, action) =>
  div().id(id).p(4).rounded(6).flex_none().cursor_pointer().text_color(t.muted).tooltip(tip)
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_mouse_down("left", stop)
    .on_click((_e, cx) => action(cx))
    .child(svg(`${ICONS}/${icon}.svg`).size(14));

// A text button: strong is the primary action.
export const pill = (t, id, label, action, { strong = false, disabled = false } = {}) =>
  div().id(id).h(28).px(12).flex().flex_none().items_center().rounded(6).text_size(12.5).font_medium()
    .when(disabled, (el) => el.opacity(0.5))
    .when(!disabled, (el) => el.cursor_pointer().on_click((_e, cx) => action(cx)))
    .when(strong, (el) => el.bg(t.solid).text_color(t.solid_foreground).when(!disabled, (e) => e.hover((s) => s.opacity(0.88))))
    .when(!strong, (el) => el.border_1().border_color(t.border).text_color(t.foreground).when(!disabled, (e) => e.hover((s) => s.bg(t.hover))))
    .on_mouse_down("left", stop)
    .child(label);

// A toggle chip for filters and pickers. dot: a color shown before the label.
export const chip = (t, id, label, on, action, dot = null) =>
  h_flex().id(id).h(22).px(8).gap(5).flex_none().items_center().rounded(11).cursor_pointer().text_size(11.5)
    .border_1().border_color(on ? t.accent : t.border)
    .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_mouse_down("left", stop)
    .on_click((_e, cx) => action(cx))
    .when(Boolean(dot), (el) => el.child(div().size(7).rounded(4).flex_none().bg(dot)))
    .child(label);

// Read-only label chips with the label's own color as a dot.
export const labelChips = (t, labels, prefix) =>
  (labels ?? []).map((l, i) => h_flex().id(`${prefix}-lbl-${i}`).flex_none().h(18).px(6).gap(4).items_center().rounded(9)
    .border_1().border_color(t.border).text_size(10.5).text_color(t.muted)
    .child(div().size(7).rounded(4).bg(`#${l.color || "888888"}`))
    .child(l.name));

export const badge = (t, text, color) =>
  div().flex_none().px(6).h(18).flex().items_center().rounded(9).text_size(10.5).font_medium().bg(color).text_color(t.background).child(text);

export const note = (t, text) => div().p(16).text_size(12.5).text_color(t.dim).child(text);

// GitHub's colors for a state, in the theme's ANSI colors.
export function stateLook(t, item) {
  if (item.isDraft && item.state !== "MERGED" && item.state !== "CLOSED") return ["Draft", t.dim];
  switch (item.state) {
    case "OPEN": return ["Open", t.ansi2];
    case "MERGED": return ["Merged", t.ansi5];
    case "CLOSED": return ["Closed", t.ansi1];
    default: return [item.state ? item.state[0] + item.state.slice(1).toLowerCase() : "", t.dim];
  }
}

// A project's single-select option colors.
export function optionColor(t, color) {
  return { GRAY: t.dim, BLUE: t.ansi4, GREEN: t.ansi2, YELLOW: t.ansi3, ORANGE: t.ansi11 ?? t.ansi3, RED: t.ansi1, PINK: t.ansi13 ?? t.ansi5, PURPLE: t.ansi5 }[color] ?? t.dim;
}

// A problem and what to do about it: the command to run (copied with a click), a page to
// open, and a way to try again. A `command` in backticks inside the message is found too.
export function problem(t, id, { message, command = null, url = null, retry = null, retryLabel = "Check again" }) {
  const cmd = command ?? /`([^`]+)`/.exec(message)?.[1] ?? null;
  const text = message.replace(/`([^`]+)`/g, "$1");
  return v_flex().id(id).flex_none().mx(10).mt(10).p(10).gap(8).rounded(8).border_1().border_color(t.blocked).bg(t.surface)
    .child(h_flex().w_full().gap(8).items_start()
      .child(div().pt(1).flex_none().text_color(t.blocked).child(svg(`${ICONS}/alert.svg`).size(14)))
      .child(div().flex_1().min_w(0).text_size(12.5).text_color(t.foreground).child(text)))
    .when(Boolean(cmd), (el) => el.child(div().w_full().px(8).py(5).rounded(5).bg(t.background).text_size(12)
      .font_family(settings().font_family).text_color(t.foreground).child(cmd)))
    .child(h_flex().w_full().gap(6).flex_wrap()
      .when(Boolean(cmd), (el) => el.child(pill(t, `${id}-copy`, "Copy command", (cx) => {
        cx.write_to_clipboard(cmd);
        notify({ title: "Command copied", body: "Paste it into a terminal and follow its steps.", level: "success", timeout: 2500 });
      }, { strong: true })))
      .when(Boolean(url), (el) => el.child(pill(t, `${id}-url`, "Install page", (cx) => cx.open_url(url), { strong: !cmd })))
      .when(Boolean(retry), (el) => el.child(pill(t, `${id}-retry`, retryLabel, retry))));
}
