/** Settings sections for the sidebar. Pure data; the sidebar owns focus. */

export type SectionId = "keys" | "editors" | "preferences";

export const SECTIONS: readonly { id: SectionId; label: string }[] = [
  { id: "keys", label: "Providers" },
  { id: "editors", label: "Editors" },
  { id: "preferences", label: "Preferences" },
];

export type SectionMoveKey =
  | "ArrowDown"
  | "ArrowUp"
  | "Home"
  | "End";

/**
 * Next focus index for the section sidebar. Arrows move one step and
 * stop at the ends (t3code's useSettingsSectionNavigation behaves the
 * same); Home and End jump. Anything else leaves focus alone.
 */
export function moveSectionIndex(
  count: number,
  index: number,
  key: string,
): number | null {
  if (count <= 0) return null;
  const clamped = Math.min(Math.max(index, 0), count - 1);
  switch (key as SectionMoveKey) {
    case "ArrowDown":
      return Math.min(clamped + 1, count - 1);
    case "ArrowUp":
      return Math.max(clamped - 1, 0);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
