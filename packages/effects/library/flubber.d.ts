/** flubber ships no TypeScript declarations; the named ESM entry is typed here. */
declare module "flubber" {
  export function interpolate(
    from: string,
    to: string,
    options?: Record<string, unknown>,
  ): (u: number) => string;
  export function separate(
    from: string,
    to: string,
    options?: Record<string, unknown>,
  ): ((u: number) => string)[];
  export function combine(
    from: string[],
    to: string[],
    options?: Record<string, unknown>,
  ): (u: number) => string;
}
