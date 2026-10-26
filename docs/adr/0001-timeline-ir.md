# 0001 — Timeline IR is the agent API

Adapters and models change. The agent’s API does not. Every edit is a changeset against `schemas/timeline.schema.json`. Editor-specific objects (Fusion comps, MLT filters, Premiere effects) are either expressed as named presets in the IR or degraded using the adapter capability manifest.

Consequences:

- The UI can preview a proposal without an NLE open.
- Two people can change Resolve and Kdenlive without editing the planner prompt in the same PR.
- Unsupported features fail as a declared fallback, not as a broken script.
