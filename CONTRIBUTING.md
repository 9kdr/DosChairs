# Contributing

Chair is a monorepo so several people can merge without sharing a long-lived branch. `main` stays releasable. Feature work lands through pull requests. Agents use the same rules. [AGENTS.md](AGENTS.md) is the short version they read first.

## Branches

```text
feat/agent/verifier-loop
fix/adapters/kdenlive-markers
chore/repo/ci-cache
```

- Branch from an up-to-date `main`.
- Keep a branch to one area when you can. Cross-area work is fine when a schema change forces it; say so in the PR.
- Delete the branch after merge.

## Reviews

- Fill in the PR template. Link the issue.
- CI jobs are `js`, `python`, and `rust`. The desktop crate is excluded from Rust CI until the Tauri system libraries are part of the runner.
- Schema edits need `pnpm test:schemas` green and a fixture update.
- Code owners default to `@9kdr`. Add yourself to `.github/CODEOWNERS` for the paths you will keep.

## Cloud runner

A scheduled workflow (`.github/workflows/code.yml`) codes one small issue per run and opens a PR. It never merges.

- Picks the oldest open `grok-ready` issue with no `agent:claimed`, no `runner-attempted`, and no linked open PR. Marks everything it touches `runner-attempted` so a failure never retries itself into a loop.
- Claims, branches `feat/<area>/<slug>`, runs a bounded Muse tool loop (25 steps, allowlisted commands, writes confined to the repo), then checks, pushes, and opens a PR. Red check means a failure comment and a released claim.
- Requires repo secrets `MUSE_API_URL`, `MUSE_API_KEY` (and optional `MUSE_MODEL`, OpenAI-compatible). Missing secrets exit loudly before any write.
- Dry run: `node scripts/runner.mjs --dry-run`. Manual run: Actions tab, `workflow_dispatch`, optional issue number.

Three shifts, three jobs, no overlap:

| Time (UTC) | Who | Job |
| --- | --- | --- |
| 04:23 daily | Groom job | Labels small slices `grok-ready`, pings stale claims |
| 05:30 weekdays | Cloud runner | Codes one `grok-ready` issue, opens a PR |
| 18:00 | Grok Bot | Reviews the tree, files new issues for groom to triage |

Grok files issues, groom labels them, the runner codes them. Nobody merges but a person.

## Commits

Short imperative subjects. The body should say why the change exists.

```text
feat(ir): reject pending changeset items

Editors need a preview that does not touch the timeline until they accept.
```

## Local checks

```bash
mise run check
mise run test
```

Python formatting and lint use Ruff. TypeScript uses Prettier and `tsc`. Rust uses rustfmt.

## Secrets and media

Do not commit API keys, Resolve scripts that embed tokens, footage, proxies, or model weights. `.env.example` lists the variables. Weights belong in `data/weights/` (gitignored).

## Adding a package

- TypeScript: new folder under `packages/` or `apps/`, with a `package.json` named `@chair/...`, and a `typecheck` script. pnpm workspace globs already include those trees.
- Python: new folder under `services/` or `adapters/`, listed in the root `[tool.uv.workspace]`, with a hatchling `pyproject.toml`.
- Rust: new crate under `crates/`, added to the workspace `members` in the root `Cargo.toml`.
