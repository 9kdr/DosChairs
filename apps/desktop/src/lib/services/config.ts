/** Where the agent and sidecar live. Same-machine defaults, env overrides. */

export const DEFAULT_AGENT_URL = "http://127.0.0.1:8787";
export const DEFAULT_SIDECAR_URL = "http://127.0.0.1:8788";

function readEnv(name: string): string | undefined {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env;
  const value = env?.[name]?.trim();
  return value ? value : undefined;
}

export function agentBaseUrl(override?: string): string {
  return (
    override?.trim() ||
    readEnv("VITE_CHAIR_AGENT_URL") ||
    readEnv("VITE_AGENT_URL") ||
    DEFAULT_AGENT_URL
  ).replace(
    /\/+$/,
    "",
  );
}

export function sidecarBaseUrl(override?: string): string {
  return (
    override?.trim() ||
    readEnv("VITE_CHAIR_SIDECAR_URL") ||
    readEnv("VITE_SIDECAR_URL") ||
    DEFAULT_SIDECAR_URL
  ).replace(/\/+$/, "");
}
