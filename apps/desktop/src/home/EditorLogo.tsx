import { cn } from "@/lib/utils";
import type { EditorId } from "./data";
import resolveMark from "./assets/davinci-resolve.png";

/** Simple Icons (CC0) path data for Kdenlive. */
const KDENLIVE_PATH =
  "m8.727 1.554 2.727 4.334v16.558h1.091V5.889l2.728-4.335zm-6 4.948V9.8h7.091c.003-.83 0-1.672-.006-2.498 0-.383-.356-.732-.718-.8H2.727zm12.303.001c-.402.024-.835.41-.834.837l-.014 12.619c0 .57.767 1.065 1.207.727l8.28-6.331c.441-.335.44-1.12 0-1.455l-8.265-6.287a.553.553 0 0 0-.374-.11zM-.001 12v3.299h9.818V12zm4.363 5.497v3.3h5.455v-3.3z";

const BRAND = {
  kdenlive: "#40A0D0",
  otio: "#7C8AFF",
} as const;

type EditorLogoProps = {
  id: EditorId;
  title?: string;
  className?: string;
};

export function EditorLogo({ id, title, className }: EditorLogoProps) {
  if (id === "resolve") {
    return (
      <img
        src={resolveMark}
        alt={title ?? ""}
        width={256}
        height={256}
        draggable={false}
        decoding="async"
        className={cn(
          // Square box + contain — never let flex stretch one axis.
          "aspect-square h-4 w-4 shrink-0 object-contain object-center",
          className,
        )}
      />
    );
  }

  if (id === "otio") {
    return (
      <svg
        viewBox="0 0 24 24"
        role="img"
        aria-hidden={title ? undefined : true}
        className={cn("size-4 shrink-0", className)}
      >
        {title ? <title>{title}</title> : null}
        <rect x="3" y="5" width="14" height="3" rx="0.5" fill={BRAND.otio} />
        <rect
          x="7"
          y="10.5"
          width="14"
          height="3"
          rx="0.5"
          fill={BRAND.otio}
          opacity="0.85"
        />
        <rect
          x="3"
          y="16"
          width="11"
          height="3"
          rx="0.5"
          fill={BRAND.otio}
          opacity="0.7"
        />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-hidden={title ? undefined : true}
      className={cn("size-4 shrink-0", className)}
    >
      {title ? <title>{title}</title> : null}
      <path fill={BRAND.kdenlive} d={KDENLIVE_PATH} />
    </svg>
  );
}
