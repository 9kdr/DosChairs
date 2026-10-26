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

If the shape of the timeline has to change, hand off to the timeline skill with the desk skill. Do not invent a second timeline format inside the adapter.
