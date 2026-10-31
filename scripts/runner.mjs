#!/usr/bin/env node
// Cloud coding runner: codes ONE grok-ready issue per run and opens a PR.
// Never merges. Bounded: 25 tool steps max, allowlisted commands only,
// writes confined to the repo with secrets/weights/media off limits.
//
// Usage: node scripts/runner.mjs [--dry-run] [--issue N]
// Env: GH_TOKEN (gh CLI), MUSE_API_URL + MUSE_API_KEY (required to code),
//   MUSE_MODEL (default "muse-spark").
//
// Pick rule: oldest open issue with grok-ready, no agent:claimed,
// no runner-attempted, and no linked open PR.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const DRY = process.argv.includes("--dry-run");
const ISSUE_ARG = (() => {
  const i = process.argv.indexOf("--issue");
  return i >= 0 ? Number(process.argv[i + 1]) : null;
})();
const MAX_STEPS = 25;
const OUT_CAP = 8000;

function sh(cmd, args, timeoutMs = 60000) {
  return execFileSync(cmd, args, {
    encoding: "utf8", timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"], cwd: ROOT,
    maxBuffer: 1024 * 1024,
  }).trim();
}

function cap(s) {
  return s.length > OUT_CAP ? s.slice(0, OUT_CAP) + "\n…(truncated)" : s;
}

// ---- issue helpers (self-contained; groom.mjs is a separate PR) ----

function listOpenIssues() {
  const out = sh("gh", ["issue", "list", "--state", "open", "--limit", "100",
    "--json", "number,title,labels,updatedAt"]);
  return JSON.parse(out || "[]");
}

function viewIssue(n) {
  const out = sh("gh", ["issue", "view", String(n), "--json", "number,title,body,labels"]);
  return JSON.parse(out);
}

function openPRsMentioning(n) {
  try {
    const out = sh("gh", ["pr", "list", "--state", "open", "--search", String(n),
      "--json", "number"]);
    return JSON.parse(out || "[]");
  } catch {
    return [];
  }
}

function names(issue) {
  return (issue.labels || []).map((l) => l.name);
}

function eligible(issue) {
  const ls = names(issue);
  if (!ls.includes("grok-ready")) return false;
  if (ls.includes("agent:claimed") || ls.includes("runner-attempted")) return false;
  return openPRsMentioning(issue.number).length === 0;
}

function comment(n, body) {
  sh("gh", ["issue", "comment", String(n), "--body", body]);
  console.log(`commented #${n}`);
}

function setLabels(n, add, remove) {
  const args = [];
  for (const l of add) args.push("--add-label", l);
  for (const l of remove) args.push("--remove-label", l);
  if (args.length) sh("gh", ["issue", "edit", String(n), ...args]);
  console.log(`labels #${n}: +${add.join(",")} -${remove.join(",")}`);
}

function slugify(title) {
  const slug = title.replace(/^\[[^\]]*\]\s*/, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug || "task";
}

// ---- path + command guards ----

const DENY_PREFIX = [".git/", "node_modules/", ".venv/", "data/weights/",
  "apps/desktop/src-tauri/gen/", ".github/"];
const DENY_NAME = [".env"];

function safePath(p) {
  if (!p || typeof p !== "string" || p.startsWith("/") || p.includes("..")) return null;
  const abs = resolve(ROOT, p);
  if (abs !== ROOT && !abs.startsWith(ROOT + "/")) return null;
  const rel = abs === ROOT ? "" : abs.slice(ROOT.length + 1);
  if (DENY_PREFIX.some((d) => rel === d.slice(0, -1) || rel.startsWith(d))) return null;
  if (DENY_NAME.some((d) => rel === d || rel.endsWith("/" + d))) return null;
  return { abs, rel };
}

// Allowlist maps exact model commands to argv. Nothing else runs.
function allowRun(cmd) {
  if (cmd === "mise run check") return { argv: ["mise", "run", "check"], timeout: 600000 };
  if (cmd === "git status") return { argv: ["git", "status", "--porcelain"], timeout: 30000 };
  if (cmd === "git diff stat") return { argv: ["git", "diff", "--stat"], timeout: 30000 };
  const m = /^node --check (\S+)$/.exec(cmd);
  if (m) {
    const safe = safePath(m[1]);
    if (safe) return { argv: ["node", "--check", safe.rel], timeout: 30000 };
  }
  return null;
}

// ---- file tools ----

function toolReadFile({ path, offset, limit }) {
  const safe = safePath(path);
  if (!safe || !existsSync(safe.abs)) return `ERROR: unreadable path: ${path}`;
  const lines = readFileSync(safe.abs, "utf8").split("\n");
  const start = Math.max(0, (offset || 1) - 1);
  const end = Math.min(lines.length, start + (limit || 200));
  return lines.slice(start, end).map((l, i) => `${start + i + 1}|${l}`).join("\n");
}

function toolSearch({ pattern }) {
  if (!pattern || pattern.length > 200) return "ERROR: bad pattern";
  try {
    const out = sh("rg", ["--no-heading", "-n", "-F", "--max-count", "50", pattern, "."], 30000);
    return cap(out || "(no matches)");
  } catch (err) {
    return err?.status === 1 ? "(no matches)" : `ERROR: ${err?.message || err}`;
  }
}

function toolEditFile({ path, find, replace }) {
  const safe = safePath(path);
  if (!safe || !existsSync(safe.abs)) return `ERROR: unreadable path: ${path}`;
  if (typeof find !== "string" || !find || typeof replace !== "string") return "ERROR: bad edit";
  const cur = readFileSync(safe.abs, "utf8");
  if (cur.indexOf(find) < 0 || cur.indexOf(find) !== cur.lastIndexOf(find)) {
    return "ERROR: find text must match exactly once";
  }
  writeFileSync(safe.abs, cur.replace(find, replace));
  return `edited ${safe.rel}`;
}

function toolWriteFile({ path, content }) {
  const safe = safePath(path);
  if (!safe || typeof content !== "string") return `ERROR: bad write`;
  if (existsSync(safe.abs)) return `ERROR: file exists, use edit_file: ${path}`;
  mkdirSync(dirname(safe.abs), { recursive: true });
  writeFileSync(safe.abs, content);
  return `wrote ${safe.rel}`;
}

function toolRun({ cmd }) {
  const allowed = allowRun(cmd);
  if (!allowed) return `ERROR: command not allowlisted: ${cmd}`;
  try {
    const out = sh(allowed.argv[0], allowed.argv.slice(1), allowed.timeout);
    return cap(out || "(no output)");
  } catch (err) {
    const tail = cap([err?.stdout, err?.stderr].filter(Boolean).join("\n"));
    return `EXIT ${err?.status ?? "?"}:\n${tail}`;
  }
}

const TOOLS = [
  { type: "function", function: { name: "read_file", description: "Read a repo file with line numbers.", parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["path"] } } },
  { type: "function", function: { name: "search", description: "Literal ripgrep search over the repo.", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } } },
  { type: "function", function: { name: "edit_file", description: "Replace exact-once text in an existing file.", parameters: { type: "object", properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } }, required: ["path", "find", "replace"] } } },
  { type: "function", function: { name: "write_file", description: "Create a new file only.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "run", description: "Run an allowlisted command: mise run check | node --check <file> | git status | git diff stat.", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } } },
  { type: "function", function: { name: "done", description: "Finish with a summary and a short imperative commit subject.", parameters: { type: "object", properties: { summary: { type: "string" }, commit_subject: { type: "string" } }, required: ["summary", "commit_subject"] } } },
];

function runTool(name, args) {
  switch (name) {
    case "read_file": return toolReadFile(args);
    case "search": return toolSearch(args);
    case "edit_file": return toolEditFile(args);
    case "write_file": return toolWriteFile(args);
    case "run": return toolRun(args);
    default: return `ERROR: unknown tool: ${name}`;
  }
}

// ---- Muse loop (OpenAI-compatible chat endpoint via secrets) ----

async function chat(messages, url, key, model) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, tools: TOOLS, max_tokens: 2000, temperature: 0.2 }),
  });
  if (!res.ok) throw new Error(`Muse API HTTP ${res.status}`);
  const data = await res.json();
  const msg = data?.choices?.[0]?.message;
  if (!msg) throw new Error("Muse API: empty reply (no tools? endpoint must support OpenAI tools)");
  return msg;
}

const SYSTEM = `You are the Chair cloud runner, an implementation bot. Rules: change only what the issue needs; keep diffs small; never merge, push, or open PRs yourself (the harness does that); never touch secrets, weights, media, .github/, or generated files; run "mise run check" before finishing; call done with a summary and a short imperative commit subject when the work is complete.`;

async function codeLoop(issue, env) {
  const area = names(issue).find((l) => l.startsWith("area:"))?.slice(5) || "docs";
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Issue #${issue.number}: ${issue.title}\nLabels: ${names(issue).join(", ")} (area: ${area})\n\n${issue.body || "(no body)"}\n\nImplement this on the current branch. Read the issue, touch the smallest set of files, run "mise run check", then call done.` },
  ];
  for (let step = 1; step <= MAX_STEPS; step += 1) {
    const msg = await chat(messages, env.url, env.key, env.model);
    messages.push(msg);
    const calls = msg.tool_calls || [];
    if (!calls.length) {
      return { summary: (msg.content || "").trim() || "stopped without tool calls",
        subject: `feat(${area}): ${slugify(issue.title)}` };
    }
    for (const call of calls) {
      const name = call.function?.name;
      let args = {};
      try { args = JSON.parse(call.function?.arguments || "{}"); } catch { /* keep {} */ }
      console.log(`step ${step}: ${name}`);
      if (name === "done") {
        return { summary: String(args.summary || "done"),
          subject: String(args.commit_subject || `feat(${area}): ${slugify(issue.title)}`) };
      }
      const out = runTool(name, args);
      messages.push({ role: "tool", tool_call_id: call.id, content: String(out).slice(0, OUT_CAP) });
    }
  }
  throw new Error(`step budget exhausted (${MAX_STEPS})`);
}

// ---- run ----

function fail(n, reason) {
  console.error(`FAILED #${n}: ${reason}`);
  comment(n, `Runner attempt failed: ${reason}\n\nClaim released. A person decides the next step.\n\n— Chair cloud runner`);
  setLabels(n, ["runner-attempted"], ["agent:claimed"]);
  process.exitCode = 1;
}

async function main() {
  let issue;
  if (ISSUE_ARG) {
    const full = viewIssue(ISSUE_ARG);
    if (!eligible(full)) {
      console.error(`#${ISSUE_ARG} is not eligible (needs grok-ready, no claim, no prior attempt, no open PR)`);
      process.exitCode = 2;
      return;
    }
    issue = full;
  } else {
    const open = listOpenIssues().filter(eligible).sort((a, b) => a.number - b.number);
    if (!open.length) {
      console.log("no eligible grok-ready issues; nothing to do");
      return;
    }
    issue = viewIssue(open[0].number);
  }

  const area = names(issue).find((l) => l.startsWith("area:"))?.slice(5) || "docs";
  const branch = `feat/${area}/${slugify(issue.title)}`;

  if (DRY) {
    console.log(`dry-run: would claim #${issue.number} (${issue.title})`);
    console.log(`dry-run: branch ${branch}`);
    console.log(`dry-run: ${MAX_STEPS}-step Muse tool loop, then check, push, PR`);
    return;
  }

  const url = process.env.MUSE_API_URL;
  const key = process.env.MUSE_API_KEY;
  const model = process.env.MUSE_MODEL || "muse-spark";
  if (!url || !key) {
    console.error("MUSE_API_URL and MUSE_API_KEY are required to code; add them as repo secrets");
    process.exitCode = 2;
    return;
  }

  setLabels(issue.number, ["agent:claimed"], []);
  comment(issue.number, `Claimed\nAgent: builder\nTool: Chair cloud runner\nBranch: ${branch}\nDoing: ${issue.title}\nNot doing: anything outside this issue\nNeed: nothing\n\nThis message is on behalf of Mel by Chair cloud runner`);

  sh("git", ["checkout", "-b", branch], 30000);
  console.log(`branch ${branch}`);

  let result;
  try {
    result = await codeLoop(issue, { url, key, model });
  } catch (err) {
    fail(issue.number, err?.message || err);
    return;
  }

  const status = sh("git", ["status", "--porcelain"], 30000);
  if (!status) {
    fail(issue.number, "loop finished with no file changes");
    return;
  }
  try {
    sh("mise", ["run", "check"], 600000);
  } catch (err) {
    fail(issue.number, `check failed:\n${cap([err?.stdout, err?.stderr].filter(Boolean).join("\n"))}`);
    return;
  }

  sh("git", ["add", "-A"], 30000);
  sh("git", ["commit", "-m", `${result.subject}\n\nCloses #${issue.number}`], 30000);
  sh("git", ["push", "-u", "origin", branch], 120000);
  const stat = sh("git", ["diff", "--stat", `origin/main...${branch}`], 30000);
  const pr = sh("gh", ["pr", "create", "--title", result.subject,
    "--body", `Closes #${issue.number}.\n\n${result.summary}\n\n\`\`\`\n${stat}\n\`\`\`\n\nCheck is green. I have not merged it.\n\nOpened by Chair cloud runner.`], 60000);
  console.log(`PR: ${pr}`);
  setLabels(issue.number, ["runner-attempted", "agent:needs-review"], ["agent:claimed"]);
}

await main();
