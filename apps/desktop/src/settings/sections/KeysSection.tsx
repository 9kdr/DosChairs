import { ChevronRightIcon, EyeIcon, EyeOffIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AgentHealth } from "@/lib/services/types";
import { cn } from "@/lib/utils";
import type { AddProviderResult } from "../add-provider";
import {
  CONNECTION_LABEL,
  followChoice,
  keySourceLabel,
  KNOWN_MODELS,
  maskKey,
  PROVIDERS,
  providerConnection,
  providerLabel,
  ROLES,
  type ConnectionState,
  type FollowChoice,
  type Provider,
  type ProviderId,
  type Role,
  type RoleId,
} from "../providers";
import type { AppSettings, RoleChoice } from "../settings-store";
import { AddProviderDialog } from "./AddProviderDialog";

function connectionDot(state: ConnectionState): string {
  if (state === "live") return "bg-emerald-400";
  if (state === "saved") return "bg-amber-400";
  if (state === "checking") return "animate-pulse bg-neutral-500"; // taste-skill-ignore: pulse matches the live dot in service-status while a check is in flight.
  return "bg-neutral-600";
}

type KeysSectionProps = {
  settings: AppSettings;
  agentUp: boolean | null;
  agentHealth: AgentHealth | undefined;
  saveKey: (provider: ProviderId, key: string | null) => Promise<void>;
  saveModel: (role: RoleId, choice: RoleChoice | null) => Promise<void>;
};

/**
 * Providers, after T3 Code's provider settings: a list of
 * configured providers with an Add row, one provider open at a
 * time, and the roles each key routes below. Saved keys render
 * masked; the full value only ever sits in the field it was
 * typed into.
 */
export function KeysSection({
  settings,
  agentUp,
  agentHealth,
  saveKey,
  saveModel,
}: KeysSectionProps) {
  const [selected, setSelected] = useState<ProviderId>("meta");
  const [addOpen, setAddOpen] = useState(false);
  const [addInitial, setAddInitial] = useState<ProviderId | null>(null);

  /** Only Meta's key is visible to the agent's environment today. */
  const metaEnvKey =
    agentUp === true && agentHealth?.key_configured === true;

  const openAdd = (initial: ProviderId | null) => {
    setAddInitial(initial);
    setAddOpen(true);
  };

  const handleAdd = async (result: AddProviderResult) => {
    await saveKey(result.provider, result.key);
    for (const override of result.overrides) {
      await saveModel(override.role, {
        provider: result.provider,
        model: override.model,
      });
    }
    setSelected(result.provider);
  };

  const detail = PROVIDERS.find((entry) => entry.id === selected) ?? PROVIDERS[0]!;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h2 className="text-xl font-semibold text-neutral-100">Providers</h2>
        <p className="mt-1 text-sm text-neutral-400">
          Keys the agent can spend, and which models each one reaches.
        </p>
      </div>

      <section aria-label="Providers">
        <div className="divide-y divide-white/[0.06] rounded-2xl bg-white/[0.03] ring-1 ring-white/[0.06]">
          {PROVIDERS.map((provider) => {
            const appKey = settings.keys[provider.id] != null;
            const envKey = provider.id === "meta" && metaEnvKey;
            const state = providerConnection({ appKey, envKey, agentUp });
            const active = provider.id === selected;
            const saved = settings.keys[provider.id];
            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => setSelected(provider.id)}
                aria-current={active}
                className="flex w-full cursor-pointer items-center gap-3 px-5 py-3 text-left outline-none hover:bg-white/[0.02] focus-visible:bg-white/[0.02]"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    connectionDot(state),
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-3">
                    <span
                      className={cn(
                        "border-b pb-px text-sm font-medium text-neutral-100",
                        active ? "border-emerald-400" : "border-transparent",
                      )}
                    >
                      {provider.label}
                    </span>
                    <span className="shrink-0 text-xs text-neutral-500">
                      {CONNECTION_LABEL[state]}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-neutral-500">
                    {saved
                      ? maskKey(saved)
                      : envKey
                        ? "No key here · the agent sees one in its environment"
                        : "No key"}
                  </span>
                </span>
                <ChevronRightIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-neutral-600"
                />
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => openAdd(null)}
            className="flex w-full cursor-pointer items-center gap-3 px-5 py-3 text-left text-sm text-neutral-400 outline-none hover:bg-white/[0.02] hover:text-neutral-100 focus-visible:bg-white/[0.02] focus-visible:text-neutral-100"
          >
            <PlusIcon aria-hidden="true" className="size-4 shrink-0" />
            Add provider
          </button>
        </div>
      </section>

      <ProviderDetail
        key={detail.id}
        provider={detail}
        saved={settings.keys[detail.id]}
        envKey={detail.id === "meta" && metaEnvKey}
        agentUp={agentUp}
        keys={settings.keys}
        models={settings.models}
        onSave={(key) => saveKey(detail.id, key)}
        onClear={() => saveKey(detail.id, null)}
        onAddKey={() => openAdd(detail.id)}
      />

      <section aria-labelledby="settings-models">
        <h3
          id="settings-models"
          className="text-sm font-medium text-neutral-400"
        >
          Models
        </h3>
        <p className="mt-1 text-xs text-neutral-500">
          Saved in the app. Roles without a pick follow the saved key;
          the agent reads CHAIR_*_MODEL from its environment today.
        </p>
        <div className="mt-3 space-y-2">
          {ROLES.map((role) => {
            const follow = followChoice(settings.keys, role);
            const followKey =
              follow != null ? settings.keys[follow.provider] : null;
            const roleSaved = settings.models[role.id];
            return (
              <ModelCard
                key={`${role.id}:${roleSaved?.provider ?? ""}:${roleSaved?.model ?? ""}`}
                role={role}
                saved={roleSaved}
                follow={follow}
                followMask={followKey != null ? maskKey(followKey) : null}
                effective={agentHealth?.models[role.id] ?? null}
                agentUp={agentUp}
                onSave={(choice) => saveModel(role.id, choice)}
                onReset={() => saveModel(role.id, null)}
              />
            );
          })}
        </div>
      </section>

      {addOpen ? (
        <AddProviderDialog
          open
          keys={settings.keys}
          savedModels={settings.models}
          initialProvider={addInitial}
          onOpenChange={setAddOpen}
          onAdd={handleAdd}
        />
      ) : null}
    </div>
  );
}

type ProviderDetailProps = {
  provider: Provider;
  saved: string | null;
  envKey: boolean;
  agentUp: boolean | null;
  keys: Record<ProviderId, string | null>;
  models: Record<RoleId, RoleChoice | null>;
  onSave: (key: string) => Promise<void>;
  onClear: () => Promise<void>;
  onAddKey: () => void;
};

/** The open provider: its key, its models, and the roles it routes. */
function ProviderDetail({
  provider,
  saved,
  envKey,
  agentUp,
  keys,
  models,
  onSave,
  onClear,
  onAddKey,
}: ProviderDetailProps) {
  const [replacing, setReplacing] = useState(false);
  const [draft, setDraft] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);

  const state = providerConnection({
    appKey: saved != null,
    envKey,
    agentUp,
  });
  const source = keySourceLabel({ appKey: saved != null, envKey });
  const known = KNOWN_MODELS[provider.id];

  const save = async () => {
    const key = draft.trim();
    if (key === "" || busy) return;
    setBusy(true);
    try {
      await onSave(key);
      setDraft("");
      setShown(false);
      setReplacing(false);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onClear();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label={`${provider.label} details`}
      className="rounded-2xl bg-white/[0.03] px-5 py-4 ring-1 ring-white/[0.06]"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-neutral-100">
          {provider.label}
        </h3>
        <p className="flex shrink-0 items-center gap-2 text-xs text-neutral-400">
          <span
            aria-hidden="true"
            className={cn("size-1.5 rounded-full", connectionDot(state))}
          />
          {CONNECTION_LABEL[state]}
        </p>
      </div>
      <p className="mt-0.5 text-xs text-neutral-500">
        {source ? `Key ${source}` : provider.blurb} ·{" "}
        <code className="font-mono">{provider.envVar}</code>
      </p>

      <div className="mt-3 flex items-center gap-2">
        {saved == null && !replacing ? (
          <>
            <p className="min-w-0 flex-1 truncate text-xs text-neutral-500">
              {envKey
                ? "Nothing saved here · the agent sees a key in its environment"
                : "No key"}
            </p>
            <Button type="button" size="sm" onClick={onAddKey}>
              Add a key
            </Button>
          </>
        ) : replacing || saved == null ? (
          <>
            <Input
              type={shown ? "text" : "password"}
              value={draft}
              autoComplete="off"
              spellCheck={false}
              aria-label={`${provider.label} API key`}
              placeholder={
                saved ? `Stored key ${maskKey(saved)}, enter a new value to replace` : "Paste a key"
              }
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void save();
              }}
              className="flex-1"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={shown ? "Hide key" : "Show key"}
              onClick={() => setShown((current) => !current)}
            >
              {shown ? <EyeOffIcon /> : <EyeIcon />}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={draft.trim() === "" || busy}
              onClick={() => void save()}
            >
              Save
            </Button>
            {saved ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setReplacing(false);
                  setDraft("");
                  setShown(false);
                }}
              >
                Cancel
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <p className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-400">
              {maskKey(saved)}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setReplacing(true)}
            >
              Replace
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void clear()}
            >
              Clear
            </Button>
          </>
        )}
      </div>

      <div className="mt-3 space-y-1 border-t border-white/[0.06] pt-3 text-xs">
        <p className="text-neutral-500">
          <span className="text-neutral-400">Models on file:</span>{" "}
          {known.length > 0 ? (
            <span className="font-mono">{known.join(", ")}</span>
          ) : (
            "none. Name one when you add the key."
          )}
        </p>
        <RoutesThrough provider={provider.id} keys={keys} models={models} />
      </div>
    </section>
  );
}

/** Which roles run through this provider, in words. */
function RoutesThrough({
  provider,
  keys,
  models,
}: {
  provider: ProviderId;
  keys: Record<ProviderId, string | null>;
  models: Record<RoleId, RoleChoice | null>;
}) {
  const lines: string[] = [];
  for (const role of ROLES) {
    const saved = models[role.id];
    if (saved != null && saved.provider === provider) {
      lines.push(`${role.label} → ${saved.model}`);
    } else if (saved == null) {
      const follow = followChoice(keys, role);
      if (follow != null && follow.provider === provider) {
        lines.push(`${role.label} follows the key → ${follow.model}`);
      }
    }
  }
  return (
    <p className="text-neutral-500">
      <span className="text-neutral-400">Roles through here:</span>{" "}
      {lines.length > 0
        ? lines.join("; ")
        : `no role routes through ${providerLabel(provider)} yet`}
    </p>
  );
}

const CUSTOM_MODEL = "__custom__";

type ModelCardProps = {
  role: Role;
  saved: RoleChoice | null;
  follow: FollowChoice | null;
  followMask: string | null;
  effective: string | null;
  agentUp: boolean | null;
  onSave: (choice: RoleChoice) => Promise<void>;
  onReset: () => Promise<void>;
};

/** Where this role routes, in words: follow the key or an override. */
function routeLine(input: {
  role: Role;
  saved: RoleChoice | null;
  follow: FollowChoice | null;
  followMask: string | null;
}): string {
  if (input.saved != null) {
    const label = providerLabel(input.saved.provider);
    return `Override: ${label} ${input.saved.model} · Reset follows the key again`;
  }
  if (input.follow == null || input.followMask == null) {
    return `${input.role.defaultModel} · no key saved`;
  }
  const follow = input.follow;
  const mask = input.followMask;
  const label = providerLabel(follow.provider);
  const model = follow.defaulted ? `${follow.model} (default)` : follow.model;
  return `${model} via ${label} key ${mask}`;
}

function ModelCard({
  role,
  saved,
  follow,
  followMask,
  effective,
  agentUp,
  onSave,
  onReset,
}: ModelCardProps) {
  const [provider, setProvider] = useState<ProviderId>(
    saved?.provider ?? follow?.provider ?? "meta",
  );
  const [model, setModel] = useState(saved?.model ?? "");
  const [custom, setCustom] = useState(
    () =>
      saved != null &&
      !KNOWN_MODELS[saved.provider].includes(saved.model),
  );
  const [stamped, setStamped] = useState(false);
  const [busy, setBusy] = useState(false);

  const known = KNOWN_MODELS[provider];

  const pickProvider = (next: string | null) => {
    if (next !== "meta" && next !== "openai" && next !== "anthropic") return;
    setProvider(next);
    setModel("");
    setCustom(KNOWN_MODELS[next].length === 0);
    setStamped(false);
  };

  const save = async () => {
    const name = model.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await onSave({ provider, model: name });
      setModel(name);
      setStamped(true);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onReset();
      setProvider("meta");
      setModel("");
      setCustom(false);
      setStamped(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl bg-white/[0.03] px-5 py-4 ring-1 ring-white/[0.06]">
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="text-sm font-medium text-neutral-100">{role.label}</h4>
        <code className="shrink-0 font-mono text-xs text-neutral-500">
          {role.envVar}
        </code>
      </div>
      <p className="mt-0.5 truncate text-xs text-neutral-500">
        {routeLine({ role, saved, follow, followMask })}
      </p>
      <div className="mt-3 flex items-center gap-2">
        <Select
          value={provider}
          onValueChange={(value) => pickProvider(value)}
          items={{ meta: "Meta", openai: "OpenAI", anthropic: "Anthropic" }}
        >
          <SelectTrigger aria-label={`${role.label} provider`} className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="meta">Meta</SelectItem>
            <SelectItem value="openai">OpenAI</SelectItem>
            <SelectItem value="anthropic">Anthropic</SelectItem>
          </SelectPopup>
        </Select>
        {known.length > 0 && !custom ? (
          <Select
            value={model === "" ? null : model}
            onValueChange={(value) => {
              if (value === CUSTOM_MODEL) {
                setCustom(true);
                setModel("");
              } else {
                setModel(value ?? "");
              }
              setStamped(false);
            }}
            items={Object.fromEntries([
              ...known.map((name) => [name, name]),
              [CUSTOM_MODEL, "Custom…"],
            ])}
          >
            <SelectTrigger aria-label={`${role.label} model`} className="flex-1">
              <SelectValue placeholder="Choose a model…" />
            </SelectTrigger>
            <SelectPopup>
              {known.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM_MODEL}>Custom…</SelectItem>
            </SelectPopup>
          </Select>
        ) : (
          <>
            <Input
              value={model}
              autoComplete="off"
              spellCheck={false}
              aria-label={`${role.label} model name`}
              placeholder="Model name"
              onChange={(event) => {
                setModel(event.target.value);
                setStamped(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void save();
              }}
              className="flex-1"
            />
            {known.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setCustom(false);
                  setModel("");
                  setStamped(false);
                }}
              >
                List
              </Button>
            ) : null}
          </>
        )}
        <Button
          type="button"
          size="sm"
          disabled={model.trim() === "" || busy}
          onClick={() => void save()}
        >
          Save
        </Button>
      </div>
      <div className="mt-2 flex h-5 items-center justify-between gap-3 text-xs">
        <p className="truncate text-neutral-500">
          {agentUp == null
            ? "Checking the agent…"
            : agentUp && effective
              ? `Agent is using ${effective}`
              : agentUp
                ? `Agent reports no model · default is ${role.defaultModel}`
                : `Agent is down · default is ${role.defaultModel}`}
        </p>
        <p className="flex shrink-0 items-center gap-2">
          {stamped ? <span className="text-neutral-400">Saved</span> : null}
          {saved ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => void reset()}
            >
              Reset
            </Button>
          ) : null}
        </p>
      </div>
    </div>
  );
}
