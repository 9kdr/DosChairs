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
