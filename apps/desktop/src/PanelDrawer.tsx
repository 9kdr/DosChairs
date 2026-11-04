import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Drawer, DrawerPopup, DrawerTitle } from "@/components/ui/drawer";

/**
 * Narrow-window home for the Plan/Shelf/History panel: a right-side coss
 * Drawer over the single column. The desktop side column stays as is above
 * 760px.
 *
 * The slide is the coss drawer animation at Chair's timing (~220ms
 * ease-out); the content inside gets one soft motion enter. The header row
 * (tabs plus close) belongs to the panel content, not the drawer.
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
  const reduce = useReducedMotion();
  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      position="right"
    >
      <DrawerPopup
        variant="straight"
        className="h-full w-full max-w-none touch-pan-y rounded-l-card bg-card duration-[220ms] ease-out motion-reduce:transition-none md:max-w-md"
      >
        <DrawerTitle className="sr-only">Project panel</DrawerTitle>
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          className="flex min-h-0 flex-1 flex-col overflow-hidden p-4"
        >
          {children}
        </motion.div>
      </DrawerPopup>
    </Drawer>
  );
}
