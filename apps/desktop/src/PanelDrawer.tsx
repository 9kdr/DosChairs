import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Narrow-window home for the Plan/Shelf/History panel: a right-side drawer
 * over the single column. The desktop side column stays as is above 760px.
 */
export function PanelDrawer({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="absolute inset-0 z-40"
      role="dialog"
      aria-modal="true"
      aria-label="Project panel"
    >
      <button
        type="button"
        aria-label="Close panel"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/60"
      />
      <div className="absolute inset-y-0 right-0 flex w-80 max-w-[85%] flex-col overflow-hidden rounded-l-card bg-card p-4 pt-12 text-neutral-100">
        <div className="flex shrink-0 justify-end pb-1">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Close panel"
            onClick={onClose}
            autoFocus
            className="rounded-lg text-neutral-400 hover:bg-white/[0.06] hover:text-neutral-100"
          >
            <X />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      </div>
    </div>
  );
}
