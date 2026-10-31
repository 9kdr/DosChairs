import type { EffectName } from "@chair/timeline-ir";

/** One creative enum with its auto-director default. */
export interface PieceEnum {
  values: readonly string[];
  default: string;
}

/** Worked example: a brief, a plan fragment, and measured finish checks. */
export interface PieceExample {
  brief: string;
  plan: Record<string, unknown>;
  checks: readonly string[];
}

/** A reusable skill: one endpoint and workflow per effect. */
export interface Piece {
  id: string;
  effect: EffectName;
  title: string;
  summary: string;
  endpoint: string;
  inputs: readonly string[];
  outputs: readonly string[];
  requiredRefs: readonly string[];
  enums: Record<string, PieceEnum>;
  example: PieceExample;
}

/** A search result lists the required refs and the defaults. */
export interface PieceHit {
  piece: Piece;
  requiredRefs: readonly string[];
  defaults: Record<string, string>;
}

/** Shared auto-director knobs: camera, lens, palette, audio. */
export const DIRECTOR_ENUMS: Record<string, PieceEnum> = {
  camera_move: { values: ["static", "push-in", "pull-out", "whip-pan", "orbit"], default: "push-in" },
  lens: { values: ["24mm", "35mm", "50mm", "85mm"], default: "35mm" },
  palette: {
    values: ["ink-paper-accent", "neon-night", "warm-film", "mono"],
    default: "ink-paper-accent",
  },
  audio: { values: ["on", "off", "ducked"], default: "on" },
};

export const DIRECTOR_DEFAULTS: Record<string, string> = Object.fromEntries(
  Object.entries(DIRECTOR_ENUMS).map(([name, spec]) => [name, spec.default]),
);

/** Fill omissible enums from defaults. Unknown names or values throw. */
function fillDefaults(
  specs: Record<string, PieceEnum>,
  params: Record<string, string>,
  what: string,
): Record<string, string> {
  for (const name of Object.keys(params)) {
    if (!(name in specs)) throw new Error(`unknown ${what}: ${name}`);
  }
  const filled: Record<string, string> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const value = params[name] ?? spec.default;
    if (!spec.values.includes(value)) throw new Error(`invalid value for ${name}: ${value}`);
    filled[name] = value;
  }
  return filled;
}

/** Fill a piece's omissible creative enums from its defaults. */
export function pieceDefaults(piece: Piece, params: Record<string, string>): Record<string, string> {
  return fillDefaults(piece.enums, params, "piece params");
}

/** Fill omitted camera/lens/palette/audio knobs. */
export function directorDefaults(params: Record<string, string>): Record<string, string> {
  return fillDefaults(DIRECTOR_ENUMS, params, "director knobs");
}

/** Rank pieces by effect type, then query overlap, then input overlap. */
export function searchPieces(
  pieces: readonly Piece[],
  opts: { effect?: EffectName; query?: string; inputs?: readonly string[] } = {},
): PieceHit[] {
  const { effect, query = "", inputs = [] } = opts;
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return pieces
    .map((piece) => {
      let score = 0;
      if (effect !== undefined && piece.effect === effect) score += 10;
      const haystack = [piece.id, piece.title, piece.summary, ...piece.inputs, ...piece.outputs]
        .join(" ")
        .toLowerCase();
      score += tokens.filter((token) => haystack.includes(token)).length;
      score += 2 * inputs.filter((want) => piece.inputs.includes(want)).length;
      return { piece, score };
    })
    .sort((a, b) => b.score - a.score || (a.piece.id < b.piece.id ? -1 : 1))
    .map(({ piece }) => ({
      piece,
      requiredRefs: piece.requiredRefs,
      defaults: Object.fromEntries(
        Object.entries(piece.enums).map(([name, spec]) => [name, spec.default]),
      ),
    }));
}
