#!/usr/bin/env bash
# Launch DaVinci Resolve Studio under Plasma Wayland with a managed frame.
#
# Resolve only ships Qt xcb and sets KDE OVERRIDE + Motif "no decorations",
# which leaves an unmanaged XWayland window. We force xcb and clear those
# hints after the window appears. A matching KWin rule (chair-resolve-frame)
# forces a Plasma titlebar when the compositor cooperates.
#
# Optional NVIDIA offload (can SIGSEGV Fusion on some hybrid+distrobox setups):
#   CHAIR_RESOLVE_NVIDIA=1 adapters/resolve/scripts/launch_resolve.sh
set -euo pipefail

RESOLVE_BIN="${RESOLVE_BIN:-/opt/resolve/bin/resolve}"
export QT_QPA_PLATFORM="${QT_QPA_PLATFORM:-xcb}"
export PYTHONPATH="/opt/resolve/Developer/Scripting/Modules${PYTHONPATH:+:$PYTHONPATH}"

if [[ "${CHAIR_RESOLVE_NVIDIA:-0}" == "1" ]]; then
  export __NV_PRIME_RENDER_OFFLOAD=1
  export __NV_PRIME_RENDER_OFFLOAD_PROVIDER="${__NV_PRIME_RENDER_OFFLOAD_PROVIDER:-NVIDIA-G0}"
  export __GLX_VENDOR_LIBRARY_NAME=nvidia
  export __VK_LAYER_NV_optimus=NVIDIA_only
fi

fix_frame() {
  local runner=(bash)
  if command -v distrobox-host-exec >/dev/null 2>&1; then
    runner=(distrobox-host-exec bash)
  fi
  "${runner[@]}" -lc '
    export DISPLAY="${DISPLAY:-:0}"
    command -v xprop >/dev/null || exit 0
    for _ in $(seq 1 90); do
      wid=""
      for id in $(xprop -root _NET_CLIENT_LIST 2>/dev/null | tr -cs "0-9a-fx" " "); do
        case "$id" in 0x*) ;; *) continue ;; esac
        cls=$(xprop -id "$id" WM_CLASS 2>/dev/null || true)
        echo "$cls" | grep -qi "\"resolve\"" || continue
        wid=$id
        break
      done
      if [ -n "$wid" ]; then
        xprop -id "$wid" -f _NET_WM_WINDOW_TYPE 32a -set _NET_WM_WINDOW_TYPE _NET_WM_WINDOW_TYPE_NORMAL
        xprop -id "$wid" -f _MOTIF_WM_HINTS 32c -set _MOTIF_WM_HINTS "2, 0, 1, 0, 0"
        xprop -id "$wid" -remove _NET_WM_STATE 2>/dev/null || \
          xprop -id "$wid" -f _NET_WM_STATE 32a -set _NET_WM_STATE 0
        # Nudge KWin to redecorate
        dbus-send --session --type=method_call --dest=org.kde.KWin /KWin org.kde.KWin.reconfigure >/dev/null 2>&1 || true
        exit 0
      fi
      sleep 0.5
    done
  ' || true
}

fix_frame &
cd /opt/resolve
exec "$RESOLVE_BIN" "$@"
