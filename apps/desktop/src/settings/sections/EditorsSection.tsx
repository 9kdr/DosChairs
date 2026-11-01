import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { EditorId, EditorInfo, EditorStatus } from "../../home/data";
import { cn } from "@/lib/utils";
import type { EditorConnection } from "../settings-store";
import {
  detectedStatus,
  EDITOR_CONNECTION_LABEL,
  EDITORS,
  editorConnection,
  type EditorConnectionState,
  type EditorMeta,
} from "../editors";

function unreachableCopy(id: EditorId, detected: EditorStatus | null): string {
  if (detected === "stopped") {
    return id === "resolve"
      ? "Linked, but Studio isn't answering — open Studio, then Recheck."
      : "Linked, but no project folder was found — check it, then Recheck.";
  }
  return "Linked, but the agent is down — Chair can't hand it the cut.";
}

function editorDot(state: EditorConnectionState): string {
  if (state === "connected") return "bg-neutral-100";
  if (state === "unreachable") return "bg-amber-400";
  if (state === "checking") return "animate-pulse bg-neutral-500"; // taste-skill-ignore: pulse matches the live dot in service-status while a check is in flight.
  return "bg-neutral-600";
}

type EditorsSectionProps = {
  connections: Record<EditorId, EditorConnection | null>;
  agentUp: boolean | null;
  /** Detected per-editor reachability; null while detection never answered. */
  detected: EditorInfo[] | null;
  saveConnection: (
    id: EditorId,
    connection: EditorConnection | null,
  ) => Promise<void>;
  refresh: () => void;
};

/**
 * Editing apps as connectable instances: link one, see whether
 * Chair can hand it the cut, and read what its adapter can do.
 */
export function EditorsSection({
  connections,
  agentUp,
  detected,
  saveConnection,
  refresh,
}: EditorsSectionProps) {
  return (
    <div className="flex flex-col gap-8">
      <p className="text-sm text-neutral-400">
        Which editing app Chair hands the cut to.
      </p>
      <div className="space-y-2">
        {EDITORS.map((editor) => (
          <EditorCard
            key={editor.id}
            editor={editor}
            connection={connections[editor.id]}
            agentUp={agentUp}
            detected={detectedStatus(detected, editor.id)}
            onConnect={(connection) =>
              saveConnection(editor.id, connection).then(() => refresh())
            }
            onDisconnect={() => saveConnection(editor.id, null)}
          />
        ))}
      </div>
    </div>
  );
}

type EditorCardProps = {
  editor: EditorMeta;
  connection: EditorConnection | null;
  agentUp: boolean | null;
  detected: EditorStatus | null;
  onConnect: (connection: EditorConnection) => Promise<void>;
  onDisconnect: () => Promise<void>;
};

function EditorCard({
  editor,
  connection,
  agentUp,
  detected,
  onConnect,
  onDisconnect,
}: EditorCardProps) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const linked = connection != null;
  const state = editorConnection({ linked, agentUp, detected });

  const connect = () => {
    if (busy) return;
    if (editor.endpointLabel != null && draft.trim() === "") return;
    setBusy(true);
    const endpoint = draft.trim() === "" ? null : draft.trim();
    setDraft("");
    void onConnect({ endpoint }).finally(() => setBusy(false));
  };

  const disconnect = () => {
    if (busy) return;
    setBusy(true);
    void onDisconnect().finally(() => setBusy(false));
  };

  const native = editor.capabilities.filter((cap) => cap.native);
  const fallbacks = editor.capabilities.filter((cap) => cap.fallback != null);
  const unsupported = editor.capabilities.filter(
    (cap) => !cap.native && cap.fallback == null,
  );

  return (
    <div className="rounded-2xl bg-white/[0.03] px-5 py-4 ring-1 ring-white/[0.06]">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-neutral-100">{editor.name}</h3>
        <p className="flex shrink-0 items-center gap-2 text-xs text-neutral-400">
          <span
            aria-hidden="true"
            className={cn("size-1.5 rounded-full", editorDot(state))}
          />
          {EDITOR_CONNECTION_LABEL[state]}
        </p>
      </div>
      <p className="mt-0.5 text-xs text-neutral-500">{editor.blurb}</p>

      <div className="mt-3 flex items-center gap-2">
        {editor.endpointLabel != null && !linked ? (
          <Input
            value={draft}
            autoComplete="off"
            spellCheck={false}
            aria-label={editor.endpointLabel}
            placeholder={editor.endpointPlaceholder ?? undefined}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") connect();
            }}
            className="flex-1"
          />
        ) : null}
        {linked ? (
          <>
            <p className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-400">
              {connection.endpoint ?? "Studio scripting"}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={disconnect}
            >
              Disconnect
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            disabled={
              busy || (editor.endpointLabel != null && draft.trim() === "")
            }
            onClick={connect}
          >
            Connect
          </Button>
        )}
      </div>

      <p className="mt-2 truncate text-xs text-neutral-500">
        {state === "connected"
          ? "Linked · the agent answered."
          : state === "unreachable"
            ? unreachableCopy(editor.id, detected)
            : state === "checking"
              ? "Checking the agent…"
              : editor.endpointLabel != null
                ? "Not linked yet."
                : "Not linked yet — open your project in Studio, then Connect."}
      </p>

      <div className="mt-3 space-y-1 border-t border-white/[0.06] pt-3 text-xs text-neutral-500">
        <p>
          <span className="text-neutral-400">Native:</span>{" "}
          {native.map((cap) => cap.label).join(", ")}
        </p>
        {fallbacks.length > 0 ? (
          <p>
            <span className="text-neutral-400">Falls back:</span>{" "}
            {fallbacks
              .map((cap) => `${cap.label} → ${cap.fallback}`)
              .join("; ")}
          </p>
        ) : null}
        {unsupported.length > 0 ? (
          <p>
            <span className="text-neutral-400">Not supported:</span>{" "}
            {unsupported.map((cap) => cap.label).join(", ")}
          </p>
        ) : null}
        <p className="text-neutral-500">
          From the {editor.name} adapter manifest · v{editor.version}
        </p>
      </div>
    </div>
  );
}
