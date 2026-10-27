"use client";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { MinusIcon, SquareIcon, XIcon } from "lucide-react";
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

/**
 * Overlay chrome for undecorated windows: a transparent top drag strip, and
 * min/max/close aligned with the home editors pill (`top-6` / `h-9`).
 */
export function WindowChrome() {
  const [maximized, setMaximized] = useState(false);
  const tauri = isTauri();

  useEffect(() => {
    if (!tauri) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const win = await appWindow();
      setMaximized(await win.isMaximized());
      unlisten = await win.onResized(async () => {
        setMaximized(await win.isMaximized());
      });
    })();
    return () => unlisten?.();
  }, [tauri]);

  const minimize = useCallback(async () => {
    if (!tauri) return;
    await (await appWindow()).minimize();
  }, [tauri]);

  const toggleMaximize = useCallback(async () => {
    if (!tauri) return;
    await (await appWindow()).toggleMaximize();
    setMaximized(await (await appWindow()).isMaximized());
  }, [tauri]);

  const close = useCallback(async () => {
    if (!tauri) return;
    await (await appWindow()).close();
  }, [tauri]);

  return (
    <div
      aria-hidden={!tauri}
      className="pointer-events-none fixed inset-x-0 top-0 z-50 h-16 select-none"
    >
      {/* Thin transparent drag band — no filled bar. */}
      <div
        data-tauri-drag-region
        className="pointer-events-auto absolute inset-x-0 top-0 h-5"
        onDoubleClick={() => void toggleMaximize()}
      />

      {/* Same vertical band as the editors status pill (pt-6 + h-9). */}
      <div
        className={cn(
          "pointer-events-auto absolute top-6 right-4 flex h-9 items-center",
          "rounded-full",
        )}
      >
        <ChromeButton label="Minimize" onClick={() => void minimize()}>
          <MinusIcon className="size-3.5" strokeWidth={1.75} />
        </ChromeButton>
        <ChromeButton
          label={maximized ? "Restore" : "Maximize"}
          onClick={() => void toggleMaximize()}
        >
          <SquareIcon className="size-3" strokeWidth={1.75} />
        </ChromeButton>
        <ChromeButton label="Close" danger onClick={() => void close()}>
          <XIcon className="size-3.5" strokeWidth={1.75} />
        </ChromeButton>
      </div>
    </div>
  );
}

function ChromeButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "flex size-9 items-center justify-center rounded-full text-muted-foreground outline-none",
        "transition-colors hover:bg-foreground/[0.06] hover:text-foreground",
        "focus-visible:bg-foreground/[0.08] focus-visible:text-foreground",
        danger &&
          "hover:bg-destructive hover:text-white focus-visible:bg-destructive focus-visible:text-white",
      )}
    >
      {children}
    </button>
  );
}
