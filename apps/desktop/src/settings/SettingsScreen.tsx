import {
  ArrowLeftIcon,
  EyeIcon,
  EyeOffIcon,
  RefreshCwIcon,
} from "lucide-react";
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
import { useServiceHealth } from "@/lib/services/useServices";
import { cn } from "@/lib/utils";
import {
  CONNECTION_LABEL,
  keySourceLabel,
  KNOWN_MODELS,
  maskKey,
  PROVIDERS,
  providerConnection,
  ROLES,
  type ConnectionState,
  type Provider,
  type ProviderId,
  type Role,
  type RoleId,
} from "./providers";
import type { RoleChoice } from "./settings-store";
import { useSettings } from "./useSettings";

function connectionDot(state: ConnectionState): string {
  if (state === "live") return "bg-emerald-400";
  if (state === "saved") return "bg-amber-400";
  if (state === "checking") return "animate-pulse bg-neutral-500"; // taste-skill-ignore: pulse matches the live dot in service-status while a check is in flight.
  return "bg-neutral-600";
}

type SettingsScreenProps = {
  onBack: () => void;
};

/**
 * Keys and models for the agent. Saved keys render masked; the full
 * value only ever sits in the password field it was typed into.
 */
export function SettingsScreen({ onBack }: SettingsScreenProps) {
  const { settings, loaded, saveKey, saveModel } = useSettings();
  const { agent, agentHealth, refresh } = useServiceHealth();
  const agentUp =
    agent.phase === "up" ? true : agent.phase === "down" ? false : null;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8">
      <header className="flex items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Back to home"
          onClick={onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold text-neutral-100">Settings</h1>
          <p className="text-sm text-neutral-400">
            Keys and models for the agent.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={refresh}
          disabled={agent.phase === "checking"}
        >
          <RefreshCwIcon />
          Recheck
        </Button>
      </header>

      {!loaded ? (
        <LoadingBlocks />
      ) : (
        <>
          <div
            aria-label="Provider connection"
            className="grid grid-cols-3 divide-x divide-white/[0.06] rounded-2xl bg-white/[0.03] ring-1 ring-white/[0.06]"
          >
            {PROVIDERS.map((provider) => {
              const appKey = settings.keys[provider.id] != null;
              const envKey =
                provider.id === "meta" &&
                agentUp === true &&
                agentHealth?.key_configured === true;
              const state = providerConnection({ appKey, envKey, agentUp });
              const source = keySourceLabel({ appKey, envKey });
              return (
                <div key={provider.id} className="min-w-0 px-4 py-3">
                  <p className="flex items-center gap-2 text-sm font-medium text-neutral-100">
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        connectionDot(state),
                      )}
                    />
                    <span className="truncate">{provider.label}</span>
                  </p>
                  <p className="mt-1 truncate text-xs text-neutral-400">
                    {CONNECTION_LABEL[state]}
                  </p>
                  <p className="truncate text-xs text-neutral-500">
                    {source ? `Key ${source}` : " "}
                  </p>
                </div>
              );
            })}
          </div>

          <section aria-labelledby="settings-keys">
            <h2
              id="settings-keys"
              className="text-sm font-medium text-neutral-400"
            >
              API keys
            </h2>
            <p className="mt-1 text-xs text-neutral-500">
              A key saved here wins; otherwise the agent falls back to .env.
            </p>
            <div className="mt-3 space-y-2">
              {PROVIDERS.map((provider) => (
                <KeyCard
                  key={provider.id}
                  provider={provider}
                  saved={settings.keys[provider.id]}
                  envKey={
                    provider.id === "meta" &&
                    agentUp === true &&
                    agentHealth?.key_configured === true
                  }
                  onSave={(key) => saveKey(provider.id, key)}
                  onClear={() => saveKey(provider.id, null)}
                />
              ))}
            </div>
          </section>

          <section aria-labelledby="settings-models">
            <h2
              id="settings-models"
              className="text-sm font-medium text-neutral-400"
            >
              Models
            </h2>
            <p className="mt-1 text-xs text-neutral-500">
              Saved in the app. The agent reads CHAIR_*_MODEL from its
              environment today.
            </p>
            <div className="mt-3 space-y-2">
              {ROLES.map((role) => (
                <ModelCard
                  key={role.id}
                  role={role}
                  saved={settings.models[role.id]}
                  effective={agentHealth?.models[role.id] ?? null}
                  agentUp={agentUp}
                  onSave={(choice) => saveModel(role.id, choice)}
                  onReset={() => saveModel(role.id, null)}
                />
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

/** Flat bars at the real size while the store loads. No shimmer. */
function LoadingBlocks() {
  return (
    <div aria-label="Loading settings" className="flex flex-col gap-8">
      <div className="h-[92px] rounded-2xl bg-white/[0.03] ring-1 ring-white/[0.06]" />
      <div className="flex flex-col gap-2">
        <div className="h-4 w-16 rounded bg-white/[0.06]" />
        <div className="h-[132px] rounded-2xl bg-white/[0.03] ring-1 ring-white/[0.06]" />
        <div className="h-[132px] rounded-2xl bg-white/[0.03] ring-1 ring-white/[0.06]" />
      </div>
    </div>
  );
}

type KeyCardProps = {
  provider: Provider;
  saved: string | null;
  envKey: boolean;
  onSave: (key: string) => Promise<void>;
  onClear: () => Promise<void>;
};

function KeyCard({ provider, saved, envKey, onSave, onClear }: KeyCardProps) {
  const [draft, setDraft] = useState("");
  const [shown, setShown] = useState(false);
  const [stamped, setStamped] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const key = draft.trim();
    if (!key || busy) return;
    setBusy(true);
    try {
      await onSave(key);
      setDraft("");
      setShown(false);
      setStamped(true);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onClear();
      setStamped(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl bg-white/[0.03] px-5 py-4 ring-1 ring-white/[0.06]">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-neutral-100">
          {provider.label}
        </h3>
        <code className="shrink-0 font-mono text-xs text-neutral-500">
          {provider.envVar}
        </code>
      </div>
      <p className="mt-0.5 text-xs text-neutral-500">{provider.blurb}</p>
      <div className="mt-3 flex items-center gap-2">
        <Input
          type={shown ? "text" : "password"}
          value={draft}
          autoComplete="off"
          spellCheck={false}
          aria-label={`${provider.label} API key`}
          placeholder={saved ? maskKey(saved) : "Paste a key"}
          onChange={(event) => {
            setDraft(event.target.value);
            setStamped(false);
          }}
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
      </div>
      <div className="mt-2 flex h-5 items-center justify-between gap-3 text-xs">
        <p className="truncate text-neutral-500">
          {saved
            ? `Saved · ${maskKey(saved)}`
            : envKey
              ? "Nothing saved here · the agent sees a key in its environment"
              : "No key"}
        </p>
        <p className="flex shrink-0 items-center gap-2">
          {stamped ? <span className="text-neutral-400">Saved</span> : null}
          {saved ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => void clear()}
            >
              Clear
            </Button>
          ) : null}
        </p>
      </div>
    </div>
  );
}

const CUSTOM_MODEL = "__custom__";

type ModelCardProps = {
  role: Role;
  saved: RoleChoice | null;
  effective: string | null;
  agentUp: boolean | null;
  onSave: (choice: RoleChoice) => Promise<void>;
  onReset: () => Promise<void>;
};

function ModelCard({
  role,
  saved,
  effective,
  agentUp,
  onSave,
  onReset,
}: ModelCardProps) {
  const [provider, setProvider] = useState<ProviderId>(
    saved?.provider ?? "meta",
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
        <h3 className="text-sm font-medium text-neutral-100">{role.label}</h3>
        <code className="shrink-0 font-mono text-xs text-neutral-500">
          {role.envVar}
        </code>
      </div>
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
