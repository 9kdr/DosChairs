"use client";

import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function appWindow() {
  return getCurrentWindow();
}

function setMaximizedAttr(maximized: boolean) {
  if (maximized) {
    document.documentElement.setAttribute("data-window-maximized", "");
  } else {
    document.documentElement.removeAttribute("data-window-maximized");
  }
}

/**
 * Overlay chrome for undecorated windows: transparent drag strip, and
 * Apple traffic lights tucked into the top-right corner. Also toggles
 * `data-window-maximized` so `.chair-shell` can drop its border-radius.
 */
export function WindowChrome() {
  const [maximized, setMaximized] = useState(false);
  const tauri = isTauri();

  useEffect(() => {
    if (!tauri) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const win = await appWindow();
      const next = await win.isMaximized();
      setMaximized(next);
      setMaximizedAttr(next);
      unlisten = await win.onResized(async () => {
        const resized = await win.isMaximized();
        setMaximized(resized);
        setMaximizedAttr(resized);
      });
    })();
    return () => {
      unlisten?.();
      setMaximizedAttr(false);
    };
  }, [tauri]);

  const minimize = useCallback(async () => {
    if (!tauri) return;
    await (await appWindow()).minimize();
  }, [tauri]);

  const toggleMaximize = useCallback(async () => {
    if (!tauri) return;
    await (await appWindow()).toggleMaximize();
    const next = await (await appWindow()).isMaximized();
    setMaximized(next);
    setMaximizedAttr(next);
  }, [tauri]);

  const close = useCallback(async () => {
    if (!tauri) return;
    await (await appWindow()).close();
  }, [tauri]);

  return (
    <div
      aria-hidden={!tauri}
      className="pointer-events-none fixed inset-x-0 top-0 z-50 h-12 select-none"
    >
      <div
        data-tauri-drag-region
        className="pointer-events-auto absolute inset-x-0 top-0 h-4"
        onDoubleClick={() => void toggleMaximize()}
      />

      <div
        className={cn(
          "group pointer-events-auto absolute top-1 right-1 flex items-center gap-2 p-2",
        )}
      >
        <TrafficLight
          label="Close"
          color="bg-[#ff5f57]"
          onClick={() => void close()}
        >
          <svg
            aria-hidden="true"
            className="size-full p-[2.5px]"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          >
            <path d="M3.5 3.5l5 5M8.5 3.5l-5 5" />
          </svg>
        </TrafficLight>
        <TrafficLight
          label="Minimize"
          color="bg-[#febc2e]"
          onClick={() => void minimize()}
        >
          <svg
            aria-hidden="true"
            className="size-full p-[2.5px]"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          >
            <path d="M2.5 6h7" />
          </svg>
        </TrafficLight>
        <TrafficLight
          label={maximized ? "Restore" : "Maximize"}
          color="bg-[#28c840]"
          onClick={() => void toggleMaximize()}
        >
          <svg
            aria-hidden="true"
            className="size-full p-[2.5px]"
            viewBox="0 0 12 12"
            fill="currentColor"
          >
            <polygon points="5.5,1.5 10.5,1.5 10.5,6.5" />
            <polygon points="6.5,10.5 1.5,10.5 1.5,5.5" />
          </svg>
        </TrafficLight>
      </div>
    </div>
  );
}

function TrafficLight({
  label,
  color,
  onClick,
  children,
}: {
  label: string;
  color: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "group/btn relative flex size-3 items-center justify-center rounded-full border border-black/15 outline-none transition-transform active:brightness-90",
        "focus-visible:ring-2 focus-visible:ring-foreground/40",
        color,
      )}
    >
      <span className="flex size-full items-center justify-center text-black/70 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 group-hover/btn:opacity-100 group-focus-visible/btn:opacity-100">
        {children}
      </span>
    </button>
  );
}
