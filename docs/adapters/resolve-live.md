# Live Resolve Studio (read smoke)

CI never opens DaVinci Resolve. On a Linux machine with **Resolve Studio** installed (this repo’s path is `/opt/resolve`), agents can launch Studio, open a cut, and check that Chair’s read path returns valid timeline IR.

Studio supports H.265/HEVC via NVDEC when the GPU is visible. Free Resolve is not enough for the scripting API.

## Launch (Plasma Wayland / distrobox)

Prefer the Chair launcher so the window gets a managed frame. Resolve only ships Qt `xcb` and often sets KDE OVERRIDE + Motif “no decorations”, which looks unmanaged under Wayland.

```bash
# From the distrobox that has /opt/resolve (or host if Studio is native)
adapters/resolve/scripts/launch_resolve.sh
```

From the host Aurora/KDE app menu, use the **DaVinci Resolve Studio** entry that runs:

`distrobox enter arch -- …/adapters/resolve/scripts/launch_resolve.sh`

Or symlink: `~/.local/bin/resolve-studio` → that script.

The launcher:

- Sets `QT_QPA_PLATFORM=xcb` and `PYTHONPATH` for scripting modules.
- Clears unmanaged Motif / window-type hints after the window appears (via `distrobox-host-exec` + `xprop` when available).
- Optionally uses NVIDIA offload if you set `CHAIR_RESOLVE_NVIDIA=1` — **off by default**; on some hybrid + distrobox setups that env SIGSEGVs Fusion at startup.

Host-only (not in git): a KWin window rule matching WM class `resolve` with **No titlebar and frame = Force No** helps Plasma keep a frame. Reconfigure with `dbus-send … org.kde.KWin.reconfigure` after editing `~/.config/kwinrulesrc`.

Bare binary still works for scripting if you only care about the API:

```bash
/opt/resolve/bin/resolve &
```

Needs a working `DISPLAY` (and usually `WAYLAND_DISPLAY` on the host session).

## One-time Studio prefs

**Preferences → System → General → External scripting:** Local (or Network). Without this, `scriptapp("Resolve")` returns nothing useful.

## Open a timeline

1. Wait until Studio is up (Project Manager or Edit page).
2. Open a project that has a timeline, and make that timeline current.
3. Optional scripting check:

```bash
export PYTHONPATH=/opt/resolve/Developer/Scripting/Modules${PYTHONPATH:+:$PYTHONPATH}
python3 -c "import DaVinciResolveScript as d; r=d.scriptapp('Resolve'); print(r); p=r.GetProjectManager().GetCurrentProject(); print(p.GetName() if p else None); t=p.GetCurrentTimeline() if p else None; print(t.GetName() if t else None)"
```

You should see a Resolve object, a project name, and a timeline name. If the timeline is `None`, open or create one in the UI (or `MediaPool.CreateEmptyTimeline` / `SetCurrentTimeline`).

## Smoke the Chair read

From the repo root:

```bash
export PYTHONPATH=/opt/resolve/Developer/Scripting/Modules${PYTHONPATH:+:$PYTHONPATH}
eval "$(mise activate bash)"
uv run --package chair-adapter-resolve python adapters/resolve/scripts/smoke_read.py
```

Expect:

- `OK`
- timeline `name`, `id`, `rate`
- track list (video/audio/subtitle) and marker count
- `data/proxies/resolve-smoke-timeline.json` (gitignored)

Unit tests (no Studio):

```bash
uv run pytest adapters/resolve
```

## GPU notes (distrobox + hybrid laptop)

Resolve should select **CUDA** on the discrete NVIDIA GPU and enable **NVDEC** (H.264/H.265/…). Check:

```bash
nvidia-smi --query-compute-apps=pid,process_name,used_gpu_memory --format=csv
rg -i 'Selected compute API|NVDEC|Main Display GPU' \
  ~/.local/share/DaVinciResolve/logs/ResolveDebug.txt | tail -20
```

On Intel+NVIDIA machines the UI OpenGL context may sit on Mesa while CUDA runs on NVIDIA. That is common; scripting still works. If the UI OOMs or interops fail, run Studio on the host or avoid forcing `CHAIR_RESOLVE_NVIDIA=1` unless you know it is stable.

## What this does not cover

Write-back, Fusion macros, and full round-trip stay on issue #23. Desktop “open project” against this IR is issue #3 (after the chat shell).
