import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ServiceState } from "@/lib/services/types";
import { useServiceHealth } from "@/lib/services/useServices";

function dotClass(state: ServiceState): string {
  if (state.phase === "up") return "bg-emerald-400";
  if (state.phase === "down") return "bg-red-400";
  return "animate-pulse bg-neutral-500"; // taste-skill-ignore: pulse matches the live dot in RunningTasks while a check is in flight.
}

function shortLabel(name: string, state: ServiceState): string {
  if (state.phase === "up") return `${name} up`;
  if (state.phase === "down") return `${name} offline`;
  return `${name} checking`;
}

function detailLine(name: string, state: ServiceState, extra: string | null): string {
  if (state.phase === "up") {
    const when = new Date(state.checkedAt).toLocaleTimeString();
    return extra ? `${name}: up · ${extra} (checked ${when})` : `${name}: up (checked ${when})`;
  }
  if (state.phase === "down") return `${name}: down — ${state.message}`;
  return `${name}: checking…`;
}

/**
 * Live agent/sidecar reachability for the project header. States come only
 * from real health fetches; nothing here is stand-in.
 */
export function ServiceStatus({ className }: { className?: string }) {
  const { agent, sidecar, agentHealth, sidecarHealth, refresh } = useServiceHealth();
  const agentLine = detailLine("Agent", agent, agentHealth ? `${agentHealth.tools.length} tools` : null);
  const sidecarLine = detailLine("Sidecar", sidecar, sidecarHealth ? sidecarHealth.device : null);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant="outline"
            render={<button type="button" onClick={refresh} />}
            aria-label={`Services: ${shortLabel("Agent", agent)}, ${shortLabel("Sidecar", sidecar)}. Activate to check again.`}
            title="Check again"
            className={cn(
              "h-7 cursor-pointer gap-2 rounded-full border-transparent bg-transparent px-2 font-normal",
              className,
            )}
          />
        }
      >
        <span aria-hidden="true" className={cn("size-1.5 rounded-full", dotClass(agent))} />
        <span aria-hidden="true" className={cn("size-1.5 rounded-full", dotClass(sidecar))} />
      </TooltipTrigger>
      <TooltipPopup side="bottom" align="end" className="max-w-72">
        <span className="flex flex-col gap-1 text-left">
          <span>{agentLine}</span>
          <span>{sidecarLine}</span>
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}
