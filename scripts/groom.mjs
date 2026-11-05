#!/usr/bin/env node
// Nightly groom: zero-cost issue triage. Heuristic only by default.
// - Labels small slices `grok-ready` (the only bot pick lane).
// - Pings stale `agent:claimed` issues once, never closes anything.
// - Muse plan-comment seam runs only when MUSE_API_KEY secret exists
//   (MUSE_API_URL is optional), at most 3 drafts per run. No hardcoded keys.
//
// Usage: node scripts/groom.mjs [--dry-run]
// Env: GH_TOKEN (gh CLI), MUSE_API_KEY, MUSE_API_URL (optional), MUSE_MODEL.

import { execFileSync } from "node:child_process";

const DRY = process.argv.includes("--dry-run");
const STALE_DAYS = 2;
const MAX_MUSE_DRAFTS = 3;
const STALE_MARK = "<!-- chair-groom:stale -->";
const PLAN_MARK = "<!-- chair-groom:plan -->";

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function listOpenIssues() {
  const out = sh("gh", ["issue", "list", "--state", "open", "--limit", "100",
    "--json", "number,title,labels,updatedAt"]);
  return JSON.parse(out || "[]");
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

function hasMarker(n, mark) {
  try {
    const out = sh("gh", ["issue", "view", String(n), "--json", "comments",
      "--jq", ".comments[].body"]);
    return out.split("\n").some((line) => line.includes(mark));
  } catch {
    return false;
  }
}

function ghWrite(n, args, summary) {
  if (DRY) {
    console.log(`dry-run: gh ${args[0]} ${args[1]} ${n} ${args.slice(2).join(" ")}`);
    return;
  }
  sh("gh", [args[0], args[1], String(n), ...args.slice(2)]);
  console.log(summary);
}

function edit(n, ...args) {
  ghWrite(n, ["issue", "edit", ...args], `edited #${n}: ${args.join(" ")}`);
}

function comment(n, body) {
  ghWrite(n, ["issue", "comment", "--body", body], `commented #${n}`);
}

function labelNames(issue) {
  return (issue.labels || []).map((l) => l.name);
}

function isSmallSlice(issue) {
  const names = labelNames(issue);
  if (names.includes("agent:claimed") || names.includes("grok-ready")) return false;
  if (!names.includes("type:task")) return false;
  if (!names.includes("p2-stretch")) return false;
  if (names.filter((n) => n.startsWith("area:")).length !== 1) return false;
  return openPRsMentioning(issue.number).length === 0;
}

function isStaleClaim(issue) {
  if (!labelNames(issue).includes("agent:claimed")) return false;
  const ageMs = Date.now() - Date.parse(issue.updatedAt);
  if (ageMs <= STALE_DAYS * 24 * 60 * 60 * 1000) return false;
  return openPRsMentioning(issue.number).length === 0;
}

// Muse seam: OpenAI-compatible chat endpoint supplied via secrets.
// Skips silently when secrets are missing; never throws the run off.
async function draftWithMuse(issue) {
  const url = process.env.MUSE_API_URL || "https://api.meta.ai/v1/chat/completions";
  const key = process.env.MUSE_API_KEY;
  if (!key) return null;
  const model = process.env.MUSE_MODEL || "muse-spark";
  const prompt = `Write one short paragraph (max 80 words) proposing a plan for GitHub issue #${issue.number} titled "${issue.title}". Name the files to touch and what done looks like. Plain sentences, no headers.`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 300,
      }),
    });
    if (!res.ok) {
      console.warn(`muse seam: HTTP ${res.status}, skipping`);
      return null;
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    return text ? `${text}\n\n${PLAN_MARK}\nDrafted with ${model}.` : null;
  } catch (err) {
    console.warn(`muse seam: ${err?.message || err}, skipping`);
    return null;
  }
}

async function main() {
  const issues = listOpenIssues();
  console.log(`open issues: ${issues.length}${DRY ? " (dry-run)" : ""}`);
  let drafts = 0;

  for (const issue of issues) {
    const small = isSmallSlice(issue);
    if (small) {
      edit(issue.number, "--add-label", "grok-ready");
    }
    if (!small && isStaleClaim(issue) && !hasMarker(issue.number, STALE_MARK)) {
      comment(issue.number,
        `Claimed over ${STALE_DAYS} days ago with no linked open PR. Still working it, or should the claim move?\n\n${STALE_MARK}\n— Chair groom (nightly, heuristic)`);
    }
    // Muse seam: only for fresh grok-ready picks, capped per run.
    if (drafts < MAX_MUSE_DRAFTS && small &&
        !hasMarker(issue.number, PLAN_MARK)) {
      const draft = await draftWithMuse(issue);
      if (draft) {
        comment(issue.number, draft);
        drafts += 1;
      }
    }
  }
  console.log(`done. drafts: ${drafts}`);
}

await main();
