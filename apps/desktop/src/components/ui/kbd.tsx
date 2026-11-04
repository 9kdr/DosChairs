import type { ReactNode } from "react";

/** One key cap in hint rows and shortcut overlays. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-md bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] font-medium text-neutral-300 ring-1 ring-inset ring-white/10">
      {children}
    </kbd>
  );
}
