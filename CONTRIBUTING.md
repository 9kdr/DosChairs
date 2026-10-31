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

## Nightly groom

A scheduled workflow (`.github/workflows/groom.yml`, 04:23 UTC) triages issues while nobody is watching. It costs nothing by default: pure `gh` heuristics, no model calls.

- Small slices gain `grok-ready`. That label is the only bot pick lane. Small means `type:task` + `p2-stretch`, one `area:`, no claim, no open PR.
- Stale `agent:claimed` issues (over 2 days, no linked open PR) get one ping comment. Nothing is closed or unclaimed automatically.
- Bots never merge and never claim outside `grok-ready`. A person still answers the merge question.
- Dry run: `node scripts/groom.mjs --dry-run`. Manual run: Actions tab, `workflow_dispatch`.

Muse seam (optional): set repository secrets `MUSE_API_URL`, `MUSE_API_KEY`, and optionally `MUSE_MODEL` to let the groom draft at most 3 short plan comments per run on fresh `grok-ready` picks. The script skips this silently when the secrets are missing. Never commit keys; `.env.example` rules apply.

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
