/** Settings sections for the header tabs. Pure data. */

export type SectionId = "keys" | "editors" | "preferences";

export const SECTIONS: readonly { id: SectionId; label: string }[] = [
  { id: "keys", label: "Providers" },
  { id: "editors", label: "Editors" },
  { id: "preferences", label: "Preferences" },
];
