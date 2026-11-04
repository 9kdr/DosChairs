/**
 * One model name everywhere: the id plus the provider in parens —
 * the string the composer picker shows, now shared with Settings.
 */
export function modelLabel(model: string, provider: string): string {
  return `${model} (${provider})`;
}
