// Finds a Claude Code agent's session transcript and turns it into prompt/answer pairs.
//
// Herdr knows the terminal, Claude Code knows the session:
//   hc get <terminal> --json            -> foreground.pid (the running `claude`)
//   ~/.claude/sessions/<pid>.json       -> sessionId and the folder it started in
//   ~/.claude/projects/<folder>/<id>.jsonl  the transcript, one JSON record per line
import { exec, home, readTextFile } from "herdr";

// Where the transcript of the Claude Code running in this terminal lives, or null.
export async function sessionFor(address) {
  const got = await exec("hc", ["get", address, "--json"]);
  if (got.code !== 0) return null;
  const top = JSON.parse(got.stdout)?.foreground?.pid;
  if (!top) return null;
  const rec = await sessionRecord(top, 3);
  if (!rec) return null;
  const { pid, s } = rec;
  const projects = `${home()}/.claude/projects`;
  let file = `${projects}/${String(s.cwd ?? "").replace(/[^A-Za-z0-9]/g, "-")}/${s.sessionId}.jsonl`;
  if ((await exec("test", ["-f", file])).code !== 0) {
    // Folder naming is Claude Code's business: look for the file by name instead.
    const found = await exec("find", [projects, "-maxdepth", "2", "-name", `${s.sessionId}.jsonl`]);
    file = found.stdout.split("\n").find(Boolean);
    if (!file) return null;
  }
  return { pid, id: s.sessionId, file, dir: file.slice(0, file.lastIndexOf("/")) };
}

// The session record of this process or, when it is a launcher, of a child below it.
async function sessionRecord(pid, depth) {
  const raw = await readTextFile(`${home()}/.claude/sessions/${pid}.json`);
  if (raw) {
    const s = JSON.parse(raw);
    if (s.sessionId) return { pid, s };
  }
  if (depth <= 0) return null;
  const kids = await exec("pgrep", ["-P", String(pid)]);
  for (const kid of kids.stdout.split("\n").filter(Boolean)) {
    const hit = await sessionRecord(kid, depth - 1);
    if (hit) return hit;
  }
  return null;
}

// Only what the cards need, cut down by jq: transcripts run to megabytes of tool output
// and images, past what exec hands back, which would drop the newest turns.
const SLIM = `select(.isSidechain != true)
  | if .type == "user" then
      if (.origin.kind == "human" and (.isMeta | not)) then
        {type, uuid, timestamp, origin, message: {content: (.message.content
          | if type == "array" then [.[] | if .type == "text" then {type, text} elif .type == "image" then {type: "image"} else empty end] else . end)}}
      else empty end
    elif .type == "assistant" then
      {type, message: {content: [.message.content[]? | if .type == "text" then {type, text} elif .type == "tool_use" then {type: "tool_use"} else empty end]}}
    elif (.type == "system" and .subtype == "turn_duration") then {type, subtype, durationMs}
    else empty end`;

// Every turn in the transcript, oldest first. Without jq, grep keeps the conversation
// records (they start with "parentUuid"), which can be too much for a long session.
export async function loadTurns(file) {
  const slim = await exec("jq", ["-c", SLIM, file]).catch(() => null);
  // jq stops at a line Claude Code is still writing and exits non-zero; what it printed
  // before that is whole and current, so use it rather than the bulkier grep.
  if (slim && (slim.code === 0 || slim.stdout)) return parseTurns(slim.stdout);
  const r = await exec("grep", ['^{"parentUuid"', file]);
  return r.code === 0 ? parseTurns(r.stdout) : [];
}

// A turn: the prompt a person typed, and the answer the model ended on (its text
// after the last tool call). done once Claude Code logs the turn's duration.
export function parseTurns(text) {
  const turns = [];
  let cur = null;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain) continue;
    if (o.type === "user") {
      if (o.origin?.kind !== "human" || o.isMeta) continue;
      const prompt = promptText(o.message?.content);
      if (!prompt) continue;
      if (cur && !cur.done) { cur.done = true; cur.interrupted = true; }
      cur = { id: o.uuid, prompt, started: o.timestamp, answer: "", texts: [], tools: 0, done: false, interrupted: false, durationMs: null };
      turns.push(cur);
    } else if (!cur) {
      continue;
    } else if (o.type === "assistant") {
      for (const b of o.message?.content ?? []) {
        if (b.type === "text" && b.text?.trim()) cur.texts.push(b.text.trim());
        else if (b.type === "tool_use") { cur.tools++; cur.texts = []; }
      }
      // Mid-turn the latest text is progress; once done it's the summary.
      if (cur.texts.length) cur.answer = cur.texts.join("\n\n");
    } else if (o.type === "system" && o.subtype === "turn_duration") {
      cur.done = true;
      cur.durationMs = o.durationMs ?? null;
    }
  }
  return turns;
}

function promptText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b.type === "text" ? b.text : b.type === "image" ? "_[image]_" : ""))
    .filter(Boolean).join("\n\n").trim();
}

// Markdown flattened to one line of plain text, cut to n characters.
export function excerpt(md, n) {
  const s = (md ?? "")
    .replace(/```[\s\S]*?(```|$)/g, " [code] ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_`~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

export function duration(ms) {
  if (ms == null) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function clock(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
