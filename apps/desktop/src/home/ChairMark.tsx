import { cn } from "@/lib/utils";

/** Pixel chair: back, seat, two legs. */
export function ChairMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 8 10"
      className={cn("h-7 w-auto shrink-0", className)}
      shapeRendering="crispEdges"
    >
      <rect x="1" y="0" width="2" height="5" fill="currentColor" />
      <rect x="1" y="5" width="5" height="2" fill="currentColor" />
      <rect x="1" y="7" width="1" height="3" fill="currentColor" />
      <rect x="5" y="7" width="1" height="3" fill="currentColor" />
    </svg>
  );
}
