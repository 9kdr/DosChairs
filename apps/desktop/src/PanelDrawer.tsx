import type { ReactNode } from "react";
import { Drawer } from "@base-ui/react/drawer";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Narrow-window home for the Plan/Shelf/History panel: a right-side drawer
 * over the single column. The desktop side column stays as is above 760px.
 *
 * Built on the Base UI Drawer, the primitive under the coss Drawer (token
 * surface, ~220ms ease-out in, quicker fade/slide out). components/ui is
 * owned by another batch, so the styled composition lives here for now.
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
  return (
    <Drawer.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Drawer.Portal>
        <Drawer.Backdrop className="fixed inset-0 z-40 bg-black/60 transition-opacity duration-200 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none" />
        <Drawer.Viewport className="fixed inset-0 z-40 flex justify-end">
          <Drawer.Popup className="flex h-full w-full flex-col overflow-hidden rounded-l-card bg-card p-4 pt-12 text-neutral-100 transition-transform duration-[220ms] ease-out data-ending-style:translate-x-full data-starting-style:translate-x-full data-ending-style:duration-150 motion-reduce:transition-none md:max-w-md">
            <Drawer.Title className="sr-only">Project panel</Drawer.Title>
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
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
