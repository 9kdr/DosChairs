# Architecture

The agent does not call DaVinci Resolve, Kdenlive, or Premiere APIs itself. It reads and writes the timeline IR. Adapters translate that IR. A changeset is a proposal: the UI accepts or rejects each item, and only accepted items are eligible to be written back.

```text
Tauri app (Rust core + webview)
  chat, timeline mirror, markers, changeset review
        |                |                 |
  editor adapters    agent runtime     model sidecar
  resolve            planner (Wonder)  SAM 3 / 3D / Audio
  kdenlive           executor (Spark)  ffmpeg proxies
  otio               verifier (Spark)
```

## Contracts

JSON Schemas in `schemas/` are the source of truth:

- `timeline.schema.json` — tracks, clips, effects, markers
- `changeset.schema.json` — proposed ops and accept/reject status
- `capability-manifest.schema.json` — what an adapter can round-trip
- `style-profile.schema.json` — stats and named presets
- `story-plan.schema.json` — beats the edits must cite

TypeScript (`packages/timeline-ir`), Rust (`crates/chair-ir`), and Python manifests should follow those files. `pnpm codegen` refreshes the schema id list in `packages/shared`.

## Adapter rule

Each adapter publishes a capability manifest. The agent plans against that manifest. A Fusion comp on Kdenlive becomes a pre-rendered overlay track instead of a failed call. Resolve is the rich path. Kdenlive is the Linux demo path. OTIO is the interchange path.

## Agent roles

- Planner (Muse Wonder): story plan, edit strategy, Fusion and grade syntax.
- Executor (Muse Spark): tool calls and local fixes.
- Verifier (Muse Spark with image and audio): critiques a proxy render before the UI shows it.

Tools return new assets or changeset items. They do not overwrite source media. The registry lives in `packages/agent-protocol` and `services/agent`.

## Processes

| Process | Default |
| --- | --- |
| Vite / Tauri webview | `http://127.0.0.1:1420` |
| Agent | `http://127.0.0.1:8787` |
| Sidecar | `http://127.0.0.1:8788` |
