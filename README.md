# Chair

[![CI](https://github.com/9kdr/DosChairs/actions/workflows/ci.yml/badge.svg)](https://github.com/9kdr/DosChairs/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-yellow.svg)](LICENSE)

Chair is an agentic, non-destructive video editor. It keeps the cut in the NLE you already use, proposes a diff instead of mutating the timeline, and learns the editor's presets instead of inventing a new look.

## Goals

- **Non-destructive**: Every edit is a changeset. Pending items do not touch the timeline.
- **Editor-native**: Resolve, Kdenlive, and OTIO are adapters. The agent talks to one timeline IR.
- **Your style**: Grades, titles, captions, and pacing come from the editor's own presets.
- **Story first**: A beat sheet sits above the timeline. Later edits cite the beat they serve.
- **Verified**: A rough cut is checked against frames and audio before it is shown.

> [!IMPORTANT]
> Chair is under heavy development. The checklist below is the map.
>
> [Open issues](https://github.com/9kdr/DosChairs/issues)

## Features

- [x] Toolchain (mise: Node, pnpm, Python, uv, Rust)
- [x] CI (`js`, `python`, `rust`)
- Timeline
  - [x] [Timeline schema](schemas/timeline.schema.json)
  - [x] [Changeset schema](schemas/changeset.schema.json)
  - [x] TypeScript IR
  - [x] Rust IR
  - [x] Pending items do not apply
  - [Project store and revisions](https://github.com/9kdr/DosChairs/issues/3)
- Agent
  - [x] Non-destructive tool registry
  - [x] Health endpoint
  - [Model clients (Wonder / Spark)](https://github.com/9kdr/DosChairs/issues/4)
  - [Transcription and subtitles](https://github.com/9kdr/DosChairs/issues/6)
  - [Shot index](https://github.com/9kdr/DosChairs/issues/7)
  - [Edit operations](https://github.com/9kdr/DosChairs/issues/8)
  - [Planner / executor / verifier](https://github.com/9kdr/DosChairs/issues/9)
  - [Story beat sheet](https://github.com/9kdr/DosChairs/issues/10)
  - [Style profile](https://github.com/9kdr/DosChairs/issues/12)
  - [Dialogue and music balance](https://github.com/9kdr/DosChairs/issues/15)
  - [Verifier gate](https://github.com/9kdr/DosChairs/issues/16)
  - [Image generation adapter](https://github.com/9kdr/DosChairs/issues/22)
- Sidecar
  - [x] Health endpoint and job kinds
  - [Proxy, frame, and loudness](https://github.com/9kdr/DosChairs/issues/5)
  - [SAM 3 mattes](https://github.com/9kdr/DosChairs/issues/14)
  - [SAM Audio stems](https://github.com/9kdr/DosChairs/issues/20)
  - [SAM 3D assets](https://github.com/9kdr/DosChairs/issues/21)
- Adapters
  - [x] Capability manifests (Resolve, Kdenlive, OTIO)
  - [Kdenlive round-trip](https://github.com/9kdr/DosChairs/issues/1)
  - [OTIO export](https://github.com/9kdr/DosChairs/issues/2)
  - [Reference grade](https://github.com/9kdr/DosChairs/issues/17)
  - [Motion template](https://github.com/9kdr/DosChairs/issues/18)
  - [Resolve Studio round-trip](https://github.com/9kdr/DosChairs/issues/23)
- Desktop
  - [x] Chat, timeline mirror, accept / reject (W.I.P)
  - [Open a project against a real timeline](https://github.com/9kdr/DosChairs/issues/3)
- Demo
  - [Rehearsal checklist](https://github.com/9kdr/DosChairs/issues/19)

Checked items exist in this repo. Linked items are not started. Milestone order is [M0](https://github.com/9kdr/DosChairs/milestone/1) through [M3](https://github.com/9kdr/DosChairs/milestone/4), then [Stretch](https://github.com/9kdr/DosChairs/milestone/5).

## Layout

```text
apps/desktop          Tauri shell and the chat / timeline / changeset UI (coss, dither, lenis — docs/adr/0002-desktop-ui-kit.md, docs/adr/0003-decoration-and-motion.md)
packages/             TypeScript IR, tool protocol, shared tokens
crates/chair-ir       Rust timeline
crates/chair-core     Revisions and accepted changesets
crates/chair-adapters Adapter trait
services/agent        Planner, executor, verifier
services/sidecar      SAM family and ffmpeg jobs
adapters/             Resolve, Kdenlive, OTIO
schemas/              JSON Schema source of truth
```

## How to run

[mise](https://mise.jdx.dev) is the toolchain.

```bash
curl https://mise.run | sh
echo 'eval "$(mise activate bash)"' >> ~/.bashrc
mise trust && mise install && mise run bootstrap
cp .env.example .env
```

Pinned tools: Node 22, pnpm 9.15, Python 3.12, uv 0.5, Rust 1.91.

```bash
mise run dev            # web UI on :1420
mise run dev:desktop    # Tauri shell (WebKitGTK on Linux)
mise run dev:agent      # http://127.0.0.1:8787/health
mise run dev:sidecar    # http://127.0.0.1:8788/health
mise run check
mise run test
```

Fedora packages for the desktop shell: `webkit2gtk4.1-devel`, `openssl-devel`, `curl`, `wget`, `libappindicator-gtk3-devel`, `librsvg2-devel`. The web UI does not need them.

Live **DaVinci Resolve Studio** launch and IR smoke (agents on a Studio machine): [docs/adapters/resolve-live.md](docs/adapters/resolve-live.md). CI does not start Resolve.

Personal overrides go in `mise.local.toml` (gitignored). Do not commit `.env`, footage, or model weights.

## Contributions

Branch from `main` as `feat/<area>/<slug>`. Areas: `desktop`, `ir`, `agent`, `sidecar`, `adapters`, `docs`. One issue per branch. Agents follow [AGENTS.md](AGENTS.md): they claim an issue before starting, talk to each other on that issue, and ask you before merging. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Docs

- [Architecture](docs/architecture.md)
- [MVP](docs/mvp.md)
- [ADR 0001: the timeline IR is the agent API](docs/adr/0001-timeline-ir.md)

## License

Apache License 2.0. See [LICENSE](LICENSE).
