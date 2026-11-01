import { cn } from "@/lib/utils";
import type { ProviderId } from "../providers";
import anthropicMark from "../assets/anthropic.svg";
import metaMark from "../assets/meta.svg";
import openaiMark from "../assets/openai.svg";

const MARKS: Record<ProviderId, string> = {
  meta: metaMark,
  openai: openaiMark,
  anthropic: anthropicMark,
};

type ProviderLogoProps = {
  id: ProviderId;
  title?: string;
  className?: string;
};

/**
 * The provider's mark, after `EditorLogo`: Simple Icons (CC0)
 * geometry kept as-is in `settings/assets`, drawn monochrome to
 * match the UI — the app stays neutral, no brand colours.
 */
export function ProviderLogo({ id, title, className }: ProviderLogoProps) {
  return (
    <img
      src={MARKS[id]}
      alt={title ?? ""}
      width={24}
      height={24}
      draggable={false}
      decoding="async"
      className={cn(
        // Square box + contain — never let flex stretch one axis.
        // brightness-0 invert redraws the black glyph in neutral white.
        "aspect-square h-4 w-4 shrink-0 object-contain object-center brightness-0 invert",
        className,
      )}
    />
  );
}
