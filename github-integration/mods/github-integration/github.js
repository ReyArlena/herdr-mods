// Finding the repo behind a folder and talking to GitHub through the `gh` CLI.
// Everything runs with exec, so it uses the person's own gh login, and runs on the
// space's machine when the space lives on another one (`on`).
import { exec } from "herdr";

export const DEFAULT_PROMPTS = {
  issue: "Can you help me address this GitHub issue? Please investigate and ask for input or changes before proceeding. Once done, ask me if I'd like to close the issue with a comment or move on. Keep a closing comment short: \"Fixed in <short commit SHA>.\" (or \"Fixed in #<PR>.\") and one line on what changed, or why it won't be done.",
  pr: "Can you help me work on this GitHub PR? Please investigate and ask for input or changes before proceeding. Once done, ask me if I'd like to comment on the PR, merge it, or move on. Keep a comment short: what changed, with the short commit SHAs it refers to.",
  project: "Can you help me work on this GitHub Project item? Please investigate and ask for input or changes before proceeding. Once done, ask me if I'd like to move the item to another status, close it with a comment, or move on. Keep a closing comment short: \"Fixed in <short commit SHA>.\" (or \"Fixed in #<PR>.\") and one line on what changed, or why it won't be done.",
};

// Defaults from earlier versions. A saved prompt equal to one of these was never really
// chosen (an older build saved the defaults with every setting), so the current default wins.
export const OLD_DEFAULT_PROMPTS = [
  "Can you help me address this GitHub issue? Please investigate and ask for input or changes before proceeding.",
  "Can you help me work on this GitHub PR? Please investigate and ask for input or changes before proceeding.",
  "Can you help me work on this GitHub Project item? Please investigate and ask for input or changes before proceeding.",
  "Can you help me address this GitHub issue? Please investigate and ask for input or changes before proceeding. Once done, ask me if I'd like to close the issue with a comment or move on.",
  "Can you help me work on this GitHub PR? Please investigate and ask for input or changes before proceeding. Once done, ask me if I'd like to comment on the PR, merge it, or move on.",
  "Can you help me work on this GitHub Project item? Please investigate and ask for input or changes before proceeding. Once done, ask me if I'd like to move the item to another status, close it with a comment, or move on.",
];

// How the agent hands a closing comment back: the mod's helper opens the Close issue
// dialog with it filled in, so the person reviews it and the agent never closes anything.
export function closeHint(appHome, repo, number) {
  return `If I want to close it, don't close it yourself: open Herdr's close dialog with your comment filled in, for me to review:\n` +
    `sh '${appHome}/mods/github-integration/close-issue.sh' ${repo} ${number} <<'EOF'\n<closing comment>\nEOF\n` +
    `(add "not planned" after ${number} if it won't be done)`;
}

export const ISSUE_STATES = ["open", "closed", "all"];
export const PR_STATES = ["open", "merged", "closed", "all"];

const LIMIT = "100";
const ISSUE_LIST = "number,title,state,labels,author,updatedAt,url";
const ISSUE_VIEW = "number,title,body,state,url,author,labels,createdAt,comments";
const PR_LIST = "number,title,state,isDraft,labels,author,updatedAt,headRefName,url";
const PR_VIEW = "number,title,body,state,isDraft,url,author,labels,createdAt,comments,headRefName,baseRefName,additions,deletions,changedFiles,reviewDecision";
const PROJECT_PAGES = 3;   // 100 items a page

const firstLine = (s) => String(s ?? "").trim().split("\n").find((l) => l.trim()) ?? "";

// exec rejects when the program can't start at all (gh missing, machine unreachable).
async function run(cmd, args, where) {
  try { return await exec(cmd, args, where); }
  catch (e) { return { code: 127, stdout: "", stderr: String(e?.message ?? e), missing: true }; }
}

function ghError(r) {
  const err = String(r.stderr ?? "") + String(r.stdout ?? "");
  if (r.missing) return "GitHub CLI (gh) is not installed or could not start.";
  if (/read:project/.test(err)) return "Projects need the read:project scope. Run `gh auth refresh -s read:project` in a terminal, then Refresh.";
  if (/connect|timed out|dial tcp|no such host/i.test(err)) return "Can't reach GitHub. Check the connection, then Refresh.";
  if (/auth login|not logged in/i.test(err)) return "gh is not logged in. Run `gh auth login` in a terminal.";
  if (/no git remotes|none of the git remotes/i.test(err)) return "This repository has no GitHub remote.";
  return firstLine(r.stderr) || "gh failed.";
}

async function ghJson(args, where) {
  const r = await run("gh", args, where);
  if (r.code !== 0) return { error: ghError(r) };
  try { return { data: JSON.parse(r.stdout) }; } catch { return { error: "Could not read gh's answer." }; }
}

async function graphql(query, vars, where) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  // -f sends strings as they are; -F is only for null (it would turn "123" into a number).
  for (const [k, v] of Object.entries(vars)) args.push(v === null ? "-F" : "-f", `${k}=${v === null ? "null" : v}`);
  const r = await ghJson(args, where);
  if (r.error) return r;
  if (r.data?.errors?.length) return { error: ghError({ stderr: r.data.errors.map((e) => e.message).join("\n") }) };
  return { data: r.data?.data };
}

// Can gh do its job on this machine? Installed, logged in, GitHub reachable. Answers
// { ok, account, scopes } (scopes: null when gh doesn't list them, e.g. a GH_TOKEN), or
// { ok: false, message, command?, url? } with what to do about it.
export async function checkGh(on) {
  const where = on ? ` on ${on}` : "";
  const v = await run("gh", ["--version"], { on });
  if (v.missing || v.code !== 0) {
    return { ok: false, message: `GitHub CLI (gh) isn't installed${where}, or can't start.`, url: "https://cli.github.com" };
  }
  let a = await run("gh", ["auth", "status", "--active", "--hostname", "github.com"], { on });
  // gh before 2.40 has no --active.
  if (/unknown flag/i.test(a.stderr)) a = await run("gh", ["auth", "status", "--hostname", "github.com"], { on });
  const out = `${a.stdout}\n${a.stderr}`;
  if (a.code !== 0) {
    if (/GH_TOKEN|GITHUB_TOKEN/.test(out) && /invalid/i.test(out)) return { ok: false, message: `The token in GH_TOKEN${where} is invalid. Replace or unset it.` };
    if (/not logged in|gh auth login/i.test(out) && !/Failed to log in/i.test(out)) return { ok: false, message: `gh isn't logged in to GitHub${where}.`, command: "gh auth login" };
    if (/connect|timeout|timed out|dial tcp|lookup|network/i.test(out)) return { ok: false, message: `Can't reach GitHub${where}. Check the connection, then check again.` };
    if (/Failed to log in|invalid|expired|revoked/i.test(out)) return { ok: false, message: `gh's GitHub login${where} has expired or is invalid. Log in again.`, command: "gh auth login" };
    return { ok: false, message: firstLine(out) || `gh can't use GitHub${where}.`, command: "gh auth status" };
  }
  const scopes = /Token scopes:\s*(.*)/.exec(out);
  return {
    ok: true,
    account: /account (\S+)/.exec(out)?.[1] ?? null,
    scopes: scopes ? [...scopes[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : null,
  };
}

export const PROJECT_SCOPE_COMMAND = "gh auth refresh -s read:project";
// Fine-grained and environment tokens list no scopes: then let GitHub answer instead.
export const canReadProjects = (health) => !health?.scopes || health.scopes.some((s) => s === "read:project" || s === "project");

// The repository's top folder, or an error. Local and fast: no network.
export async function repoRoot(cwd, on) {
  const r = await run("git", ["rev-parse", "--show-toplevel"], { cwd: cwd || undefined, on });
  if (r.code !== 0) return { error: r.missing ? "git could not start." : "Not in a git repository." };
  return { root: r.stdout.trim() };
}

// owner/name for a repo folder, as gh resolves it (honours `gh repo set-default`).
export async function repoName(root, on) {
  const r = await ghJson(["repo", "view", "--json", "nameWithOwner,url"], { cwd: root, on });
  return r.error ? r : { repo: r.data.nameWithOwner, url: r.data.url };
}

const where = (place) => ({ cwd: place.root, on: place.on });

export async function listIssues(place, state) {
  const r = await ghJson(["issue", "list", "-R", place.repo, "--state", state, "--limit", LIMIT, "--json", ISSUE_LIST], where(place));
  return r.error ? r : { items: r.data };
}

export async function viewIssue(place, repo, number) {
  const r = await ghJson(["issue", "view", String(number), "-R", repo, "--json", ISSUE_VIEW], where(place));
  return r.error ? r : { item: r.data };
}

export async function listPrs(place, state) {
  const r = await ghJson(["pr", "list", "-R", place.repo, "--state", state, "--limit", LIMIT, "--json", PR_LIST], where(place));
  return r.error ? r : { items: r.data };
}

export async function viewPr(place, repo, number) {
  const r = await ghJson(["pr", "view", String(number), "-R", repo, "--json", PR_VIEW], where(place));
  return r.error ? r : { item: r.data };
}

export async function listLabels(place) {
  const r = await ghJson(["label", "list", "-R", place.repo, "--limit", "200", "--json", "name,color,description"], where(place));
  return r.error ? r : { items: r.data.toSorted((a, b) => a.name.localeCompare(b.name)) };
}

export const CLOSE_REASONS = [["completed", "Completed"], ["not planned", "Not planned"]];

// Title and state, for a close request that came from outside (close-issue.sh).
export async function issueSummary(repo, number, on) {
  const r = await ghJson(["issue", "view", String(number), "-R", repo, "--json", "title,state,url"], { on });
  return r.error ? r : { item: r.data };
}

// Closes an issue, with an optional closing comment.
export async function closeIssue(place, repo, number, { comment, reason }) {
  const args = ["issue", "close", String(number), "-R", repo, "--reason", reason];
  if (comment?.trim()) args.push("--comment", comment.trim());
  const r = await run("gh", args, where(place));
  return r.code === 0 ? { ok: true } : { error: ghError(r) };
}

// Creates the issue and answers its number and URL.
export async function createIssue(place, { title, body, labels }) {
  const args = ["issue", "create", "-R", place.repo, "--title", title, "--body", body ?? ""];
  for (const l of labels ?? []) args.push("--label", l);
  const r = await run("gh", args, where(place));
  if (r.code !== 0) return { error: ghError(r) };
  const url = r.stdout.trim().split("\n").find((l) => /\/issues\/\d+/.test(l)) ?? "";
  const number = Number(/\/issues\/(\d+)/.exec(url)?.[1]);
  return number ? { number, url } : { error: "gh created the issue but its URL was not understood." };
}

const LINKED_PROJECTS = `query($o:String!,$r:String!){repository(owner:$o,name:$r){projectsV2(first:20){nodes{id number title url closed}}}}`;

// The open projects linked to the repo.
export async function linkedProjects(place) {
  const [o, r] = place.repo.split("/");
  const res = await graphql(LINKED_PROJECTS, { o, r }, where(place));
  if (res.error) return res;
  return { items: (res.data?.repository?.projectsV2?.nodes ?? []).filter((p) => p && !p.closed) };
}

const LABELS = "labels(first:10){nodes{name color}} assignees(first:5){nodes{login}}";
const PROJECT_ITEMS = `query($id:ID!,$after:String){node(id:$id){... on ProjectV2{title url
  field(name:"Status"){... on ProjectV2SingleSelectField{options{name color}}}
  items(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id fullDatabaseId type updatedAt
    fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}
    content{
      ... on DraftIssue{title body createdAt creator{login}}
      ... on Issue{number title url state repository{nameWithOwner} ${LABELS}}
      ... on PullRequest{number title url state isDraft repository{nameWithOwner} ${LABELS}}}}}}}}`;

export const NO_STATUS = "No status";

// Where an item lives on GitHub: an issue or PR's own page; a draft opens in its project.
export const itemUrl = (project, item) =>
  item.url ?? (item.dbId ? `${project.url}?pane=issue&itemId=${item.dbId}` : project.url);

// The project's items in board order, with its Status options (in their order).
export async function projectItems(place, id) {
  let after = null, items = [], project = null;
  for (let page = 0; page < PROJECT_PAGES; page++) {
    const res = await graphql(PROJECT_ITEMS, { id, after }, where(place));
    if (res.error) return res;
    const node = res.data?.node;
    if (!node) return { error: "Project not found." };
    project ??= { title: node.title, url: node.url, statuses: node.field?.options ?? [] };
    for (const n of node.items?.nodes ?? []) {
      const c = n.content ?? {};
      items.push({
        id: n.id, dbId: n.fullDatabaseId ?? null, type: n.type, updatedAt: n.updatedAt,
        status: n.fieldValueByName?.name ?? NO_STATUS,
        title: c.title ?? "(no title)", body: c.body ?? null, number: c.number ?? null, url: c.url ?? null,
        state: c.state ?? null, isDraft: c.isDraft ?? false, repo: c.repository?.nameWithOwner ?? null,
        author: c.creator ? { login: c.creator.login } : null,
        labels: c.labels?.nodes ?? [], assignees: (c.assignees?.nodes ?? []).map((a) => a.login),
      });
    }
    if (!node.items?.pageInfo?.hasNextPage) break;
    after = node.items.pageInfo.endCursor;
  }
  return { project, items };
}

// What the agent gets: the person's prefix, then a reference it can look up with gh.
// Issues and PRs leave their body out (the agent reads them and their comments itself);
// a project's draft item can't be looked up, so its body goes along.
export function issuePrompt(prefix, repo, issue, hint = "") {
  return `${prefix.trim()}\n\n${repo}#${issue.number}: ${issue.title}\n${issue.url}${hint ? `\n\n${hint}` : ""}`;
}
export function prPrompt(prefix, repo, pr) {
  return `${prefix.trim()}\n\n${repo}#${pr.number}: ${pr.title}\n${pr.url}`;
}
export function projectPrompt(prefix, project, item, hint = "") {
  const head = `${prefix.trim()}\n\nProject: ${project.title} (${project.url})\nStatus: ${item.status}`;
  if (item.type === "DRAFT_ISSUE") return `${head}\nDraft item: ${item.title}${item.body?.trim() ? `\n\n${item.body.trim()}` : ""}`;
  const kind = item.type === "PULL_REQUEST" ? "Pull request" : "Issue";
  return `${head}\n${kind}: ${item.repo}#${item.number}: ${item.title}\n${item.url}${hint && item.type === "ISSUE" ? `\n\n${hint}` : ""}`;
}

export function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "now";
  const steps = [[60, "m"], [24, "h"], [30, "d"], [12, "mo"]];
  let v = s / 60;
  for (const [size, unit] of steps) {
    if (v < size) return `${Math.floor(v)}${unit}`;
    v /= size;
  }
  return `${Math.floor(v)}y`;
}

export const matches = (item, filter) => {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  const hay = [item.number ? `#${item.number}` : "", item.title, item.author?.login ?? "", item.status ?? "", item.repo ?? "",
    ...(item.labels ?? []).map((l) => l.name), ...(item.assignees ?? [])].join(" ").toLowerCase();
  return f.split(/\s+/).every((w) => hay.includes(w));
};
