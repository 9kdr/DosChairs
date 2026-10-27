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

function setMaximizedAttr(maximized: boolean) {
  if (maximized) {
    document.documentElement.setAttribute("data-window-maximized", "");
  } else {
    document.documentElement.removeAttribute("data-window-maximized");
  }
}

/**
 * Overlay chrome for undecorated windows: transparent drag strip, and
 * min/max/close tucked into the top-right corner. Also toggles
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
          "pointer-events-auto absolute top-1 right-1 flex items-center",
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
        "flex size-8 items-center justify-center rounded-full text-muted-foreground outline-none",
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
