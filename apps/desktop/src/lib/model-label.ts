/**
 * One model name everywhere: the id plus the provider in parens —
 * the string the composer picker shows, now shared with Settings.
 */
export function modelLabel(model: string, provider: string): string {
  return `${model} (${provider})`;
}

/**
 * Short trigger label for a picker option: the human model name, no
 * provider suffix. Unknown ids pass through unchanged.
 */
export function orchestratorLabel(option: string): string {
  const id = option.replace(/ \([^()]*\)$/, "");
  const family = /^muse-([a-z]+)/.exec(id)?.[1];
  if (family == null) return id;
  return `Muse ${family.charAt(0).toUpperCase()}${family.slice(1)}`;
}
