# Cutroom

Agentic, non-destructive video editing that learns an editor’s style. The agent never mutates an NLE directly. It reads and writes a timeline IR, proposes a changeset, and the editor accepts or rejects each item.

GitHub repo: [9kdr/DosChairs](https://github.com/9kdr/DosChairs). Cutroom is the product name.

## Layout

| Path | What it owns |
| --- | --- |
| `apps/desktop` | Tauri shell and the chat / timeline / changeset UI |
| `packages/timeline-ir` | TypeScript timeline and changeset types |
| `packages/agent-protocol` | Tool contracts shared with the UI |
| `packages/shared` | Ports, work-log phases, schema id list |
| `packages/ui` | Shared visual tokens |
| `crates/cutroom-ir` | Rust timeline IR |
| `crates/cutroom-core` | Revisions and accepted-changeset filtering |
| `crates/cutroom-adapters` | Adapter trait and capability flags |
| `services/agent` | Planner, executor, verifier (Python) |
| `services/sidecar` | SAM family and ffmpeg jobs (Python, GPU) |
| `adapters/resolve` | DaVinci Resolve (Studio scripting) |
| `adapters/kdenlive` | Linux-native MLT XML path |
| `adapters/otio` | OTIO / FCPXML / EDL interchange |
| `schemas` | JSON Schema source of truth |

## Local setup

[mise](https://mise.jdx.dev) is the toolchain. From a fresh clone:

```bash
curl https://mise.run | sh
echo 'eval "$(mise activate bash)"' >> ~/.bashrc
cd /path/to/DosChairs
mise trust
mise install
mise run bootstrap
cp .env.example .env
```

Pinned tools: Node 22, pnpm 9.15, Python 3.12, uv 0.5, Rust 1.91.

```bash
mise run dev            # Vite UI on :1420
mise run dev:desktop    # Tauri shell (WebKitGTK on Linux)
mise run dev:agent      # http://127.0.0.1:8787/health
mise run dev:sidecar    # http://127.0.0.1:8788/health
mise run check
mise run test
```

Fedora packages for the desktop shell: `webkit2gtk4.1-devel`, `openssl-devel`, `curl`, `wget`, `libappindicator-gtk3-devel`, `librsvg2-devel`. The web UI does not need them.

Personal overrides go in `mise.local.toml` (gitignored). Do not commit `.env` or model weights.

## How people work in parallel

`main` accepts pull requests. Branch from `main`:

```text
feat/<area>/<slug>
fix/<area>/<slug>
chore/<area>/<slug>
```

Areas: `desktop`, `ir`, `agent`, `sidecar`, `adapters`, `docs`.

One issue per branch. Schema changes (`schemas/`, `packages/timeline-ir`, `crates/cutroom-ir`) should be their own PR so adapters and the agent do not collide. Details are in [CONTRIBUTING.md](CONTRIBUTING.md). The MVP map is in [docs/mvp.md](docs/mvp.md).

## What is real today

The IR schemas, a small changeset rule (pending items do not apply), capability manifests for Resolve, Kdenlive, and OTIO, health servers for the agent and sidecar, and a UI that can accept or reject proposal items. Model calls, SAM inference, and editor write-back are still open issues.
