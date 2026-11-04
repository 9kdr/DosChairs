/**
 * The approved `@chair/effects` import for effect modules: browser-safe,
 * synchronous helpers only. Everything is a pure function of its inputs.
 * The prompt catalogue (packages/ograf/approved-imports.json) lists these.
 */
export * from "./types.js";
export * from "./easing.js";
export * from "./noise.js";
export * from "./dither.js";
export * from "./physics.js";
export { ShaderPass, boundUniforms } from "./shader.js";
export type { ShaderPassProps, UniformInput } from "./shader.js";
export * from "./color.js";
