---
name: chair-adapter
description: Update a Chair editor adapter and its capability manifest together. Use when editing adapters/ or when the user mentions Resolve, Kdenlive, OTIO, or interchange.
---

# Adapters

Each folder under `adapters/` says what that editor can round-trip. The manifest and the code change in the same pull request.

- Kdenlive is the Linux path. Resolve needs Studio. OTIO is the interchange path and will drop some detail.
- If a feature is missing, record the fallback in the manifest. Do not pretend the editor can do it.
- Refer to grades, titles, and captions by the editor's preset name.
- Leave the source file untouched.

## Live Resolve smoke (Linux Studio)

CI never launches Resolve. Agents on a machine with Studio can:

1. Start Studio if needed: `/opt/resolve/bin/resolve` (needs `DISPLAY`). Wait until `scriptapp("Resolve")` returns an object.
2. Open a project that has a current timeline (scripting: `ProjectManager.LoadProject`, `SetCurrentTimeline`).
3. Preferences > System > General > External scripting: **Local** (or Network).
4. From the repo root:

```bash
export PYTHONPATH=/opt/resolve/Developer/Scripting/Modules${PYTHONPATH:+:$PYTHONPATH}
eval "$(mise activate bash)"
uv run --package chair-adapter-resolve python adapters/resolve/scripts/smoke_read.py
```

Expect `OK`, track list, and `data/proxies/resolve-smoke-timeline.json` (gitignored). Unit tests stay: `uv run pytest adapters/resolve`.

If the shape of the timeline has to change, hand off to the timeline skill with the desk skill. Do not invent a second timeline format inside the adapter.
