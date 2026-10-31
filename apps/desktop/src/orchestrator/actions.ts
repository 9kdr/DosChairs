export type ActionKey =
  | "note"
  | "like"
  | "preset"
  | "again"
  | "script"
  | "accept"
  | "brief";

export type Action = {
  key: ActionKey;
  hint: string;
  slot: string;
};

export const ACTIONS: readonly Action[] = [
  { key: "note", hint: "Critique this look", slot: "what to change" },
  { key: "like", hint: "Match a pin", slot: "which pin" },
  { key: "preset", hint: "Apply a named preset", slot: "preset name" },
  { key: "again", hint: "Another pass, same rules", slot: "" },
  { key: "script", hint: "Use the pinned script", slot: "which part" },
  { key: "accept", hint: "Accept this proposal", slot: "" },
  { key: "brief", hint: "Open the plan", slot: "" },
];

export function filterActions(query: string): Action[] {
  const needle = query.trim().toLowerCase().replace(/^\//, "");
  if (!needle) return [...ACTIONS];
  return ACTIONS.filter(
    (action) =>
      action.key.startsWith(needle) || action.hint.toLowerCase().includes(needle),
  );
}

export function parseAction(text: string): { key: ActionKey; slot: string } | null {
  const trimmed = text.trim().replace(/^\//, "");
  const lower = trimmed.toLowerCase();
  const known = ACTIONS.find(
    (action) =>
      lower === action.key ||
      lower.startsWith(`${action.key} `) ||
      lower.startsWith(`${action.key}:`),
  );
  if (!known) return null;
  return {
    key: known.key,
    slot: trimmed.slice(known.key.length).replace(/^[:\s]+/, ""),
  };
}
