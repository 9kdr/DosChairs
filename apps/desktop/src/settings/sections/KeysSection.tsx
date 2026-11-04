import { EyeIcon, EyeOffIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { AgentHealth } from "@/lib/services/types";
import { cn } from "@/lib/utils";
import type { AddProviderResult } from "../add-provider";
import {
  addCustomModel,
  CONNECTION_LABEL,
  keyDetectionHint,
  keySourceLabel,
  KNOWN_MODELS,
  maskKey,
  PROVIDERS,
  providerConnection,
  removeCustomModel,
  trimKeyDraft,
  type ConnectionState,
  type Provider,
  type ProviderId,
} from "../providers";
import type { AppSettings } from "../settings-store";
import { AddProviderDialog } from "./AddProviderDialog";
import { ProviderLogo } from "./ProviderLogo";

function connectionDot(state: ConnectionState): string {
  if (state === "live") return "bg-neutral-100";
  if (state === "saved") return "bg-amber-400";
  if (state === "checking") return "animate-pulse bg-neutral-500"; // taste-skill-ignore: pulse matches the live dot in service-status while a check is in flight.
  return "bg-neutral-600";
}

type KeysSectionProps = {
  settings: AppSettings;
  agentUp: boolean | null;
  agentHealth: AgentHealth | undefined;
  saveKey: (provider: ProviderId, key: string | null) => Promise<void>;
  saveProviderEnabled: (provider: ProviderId, enabled: boolean) => Promise<void>;
  saveCustomModels: (provider: ProviderId, models: string[]) => Promise<void>;
  saveModelEnabled: (
    provider: ProviderId,
    model: string,
    enabled: boolean,
  ) => Promise<void>;
};

/**
 * Providers: one list, and the selected provider opens in place with
 * its key and models. Each row carries its own status and on/off
 * switch. Saved keys render masked; the full value only ever sits in
 * the field it was typed into.
 */
export function KeysSection({
  settings,
  agentUp,
  agentHealth,
  saveKey,
  saveProviderEnabled,
  saveCustomModels,
  saveModelEnabled,
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
    await saveProviderEnabled(result.provider, true);
    setSelected(result.provider);
  };

  return (
    <div className="flex flex-col gap-8">
      <p className="text-sm text-neutral-400">
        Keys the agent can spend, and which models each one reaches.
      </p>

      <section aria-label="Providers">
        <div className="rounded-card bg-card text-neutral-100">
          <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-3">
            <p className="text-sm text-neutral-400">
              {PROVIDERS.length} providers
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Add provider"
              onClick={() => openAdd(null)}
            >
              <PlusIcon />
            </Button>
          </div>

          <div
            aria-label="Provider list"
            className="flex flex-col divide-y divide-white/[0.06]"
          >
            {PROVIDERS.map((provider) => {
              const appKey = settings.keys[provider.id] != null;
              const envKey = provider.id === "meta" && metaEnvKey;
              const enabled = settings.enabled[provider.id];
              const state = providerConnection({ appKey, envKey, agentUp });
              const open = provider.id === selected;
              return (
                <div key={provider.id}>
                  <ProviderRow
                    provider={provider}
                    state={state}
                    enabled={enabled}
                    active={open}
                    onSelect={() => setSelected(provider.id)}
                    onToggle={(next) =>
                      void saveProviderEnabled(provider.id, next)
                    }
                  />
                  {open ? (
                    <div className="px-5 pt-1 pb-5">
                      <ProviderDetail
                        key={provider.id}
                        provider={provider}
                        saved={settings.keys[provider.id]}
                        envKey={envKey}
                        customModels={settings.customModels[provider.id]}
                        disabledModels={settings.disabledModels[provider.id]}
                        onSave={(key) => saveKey(provider.id, key)}
                        onClear={() => saveKey(provider.id, null)}
                        onSaveCustomModels={(models) =>
                          saveCustomModels(provider.id, models)
                        }
                        onToggleModel={(model, modelEnabled) =>
                          saveModelEnabled(provider.id, model, modelEnabled)
                        }
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {addOpen ? (
        <AddProviderDialog
          open
          keys={settings.keys}
          initialProvider={addInitial}
          onOpenChange={setAddOpen}
          onAdd={handleAdd}
        />
      ) : null}
    </div>
  );
}

type ProviderRowProps = {
  provider: Provider;
  state: ConnectionState;
  enabled: boolean;
  active: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
};

/** One provider row: status, name, and on/off switch. Opens in place. */
function ProviderRow({
  provider,
  state,
  enabled,
  active,
  onSelect,
  onToggle,
}: ProviderRowProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 px-4 py-3 transition-colors hover:bg-white/[0.04]",
        active && "bg-white/[0.04]",
        !enabled && "opacity-60",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-expanded={active}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-white/40"
      >
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            enabled ? connectionDot(state) : "bg-neutral-600",
          )}
        />
        <ProviderLogo id={provider.id} />
        <span className="min-w-0 flex-1">
          <span
            title={provider.label}
            className="block truncate text-sm font-medium text-neutral-100"
          >
            {provider.label}
          </span>
          <span
            title={enabled ? CONNECTION_LABEL[state] : "Off"}
            className="mt-0.5 block truncate text-xs text-muted-foreground"
          >
            {enabled ? CONNECTION_LABEL[state] : "Off"}
          </span>
        </span>
      </button>
      <Switch
        checked={enabled}
        onCheckedChange={(next) => onToggle(next)}
        aria-label={`${provider.label} enabled`}
        className="shrink-0"
      />
    </div>
  );
}

type ProviderDetailProps = {
  provider: Provider;
  saved: string | null;
  envKey: boolean;
  customModels: string[];
  disabledModels: string[];
  onSave: (key: string) => Promise<void>;
  onClear: () => Promise<void>;
  onSaveCustomModels: (models: string[]) => Promise<void>;
  onToggleModel: (model: string, enabled: boolean) => Promise<void>;
};

/**
 * The open provider, in place under its row: where its key lives,
 * then the key, then its models. The row above already names the
 * provider and its status, so this says neither again.
 */
function ProviderDetail({
  provider,
  saved,
  envKey,
  customModels,
  disabledModels,
  onSave,
  onClear,
  onSaveCustomModels,
  onToggleModel,
}: ProviderDetailProps) {
  const source = keySourceLabel({ appKey: saved != null, envKey });

  return (
    <div aria-label={`${provider.label} details`}>
      <p className="text-xs text-muted-foreground">
        {source ? `Key ${source} · ` : null}
        <code className="font-mono">{provider.envVar}</code>
      </p>

      <KeyBlock
        provider={provider}
        saved={saved}
        envKey={envKey}
        onSave={onSave}
        onClear={onClear}
      />

      <ModelsBlock
        provider={provider}
        customModels={customModels}
        disabledModels={disabledModels}
        onSaveCustomModels={onSaveCustomModels}
        onToggleModel={onToggleModel}
      />
    </div>
  );
}

type KeyBlockProps = {
  provider: Provider;
  saved: string | null;
  envKey: boolean;
  onSave: (key: string) => Promise<void>;
  onClear: () => Promise<void>;
};

/**
 * The provider's API key: typed inline when missing — Enter or
 * Save commits — masked once saved, replaceable, clearable.
 */
function KeyBlock({
  provider,
  saved,
  envKey,
  onSave,
  onClear,
}: KeyBlockProps) {
  const [draft, setDraft] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);

  const hint = keyDetectionHint(draft, provider.id);

  const save = async () => {
    const key = trimKeyDraft(draft);
    if (key == null || busy) return;
    setBusy(true);
    try {
      await onSave(key);
      setDraft("");
      setShown(false);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onClear();
      setDraft("");
      setShown(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4">
      <p className="text-sm font-medium text-neutral-100">API key</p>
      {saved == null ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {envKey
            ? "Nothing saved here · the agent sees a key in its environment"
            : "No key — paste one below"}
        </p>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        <Input
          type={shown ? "text" : "password"}
          value={draft}
          autoComplete="off"
          spellCheck={false}
          aria-label={`${provider.label} API key`}
          placeholder={
            saved
              ? `Stored key ${maskKey(saved)}, enter a new value to replace`
              : "Paste a key"
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
          disabled={trimKeyDraft(draft) == null || busy}
          onClick={() => void save()}
        >
          Save
        </Button>
        {saved != null ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void clear()}
          >
            Clear
          </Button>
        ) : null}
      </div>
      {hint != null ? (
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

type ModelsBlockProps = {
  provider: Provider;
  customModels: string[];
  disabledModels: string[];
  onSaveCustomModels: (models: string[]) => Promise<void>;
  onToggleModel: (model: string, enabled: boolean) => Promise<void>;
};

/**
 * Models on file for the provider: the known ids, then the typed
 * ones, then the button to type another. Each row carries its own
 * on/off switch; a model switched off leaves the picker and role
 * routing. The list never invents names it has not seen.
 */
function ModelsBlock({
  provider,
  customModels,
  disabledModels,
  onSaveCustomModels,
  onToggleModel,
}: ModelsBlockProps) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [duplicate, setDuplicate] = useState(false);
  const [busy, setBusy] = useState(false);

  const known = KNOWN_MODELS[provider.id];

  const add = async () => {
    const next = addCustomModel({ custom: customModels, known, draft });
    if (next == null || busy) {
      setDuplicate(draft.trim() !== "");
      return;
    }
    setBusy(true);
    try {
      await onSaveCustomModels(next);
      setDraft("");
      setDuplicate(false);
      setAdding(false);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (model: string) => {
    const next = removeCustomModel(customModels, model);
    if (next == null || busy) return;
    setBusy(true);
    try {
      await onSaveCustomModels(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 border-t border-white/[0.06] pt-4">
      <p className="text-sm font-medium text-neutral-100">Models</p>
      {known.length === 0 && customModels.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          No models on file yet. Add one below.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1">
          {known.map((name) => {
            const off = disabledModels.includes(name);
            return (
              <li
                key={name}
                className={cn(
                  "flex items-center gap-2 rounded-xl bg-white/[0.03] px-3 py-1.5",
                  off && "opacity-60",
                )}
              >
                <span className="min-w-0 flex-1 truncate text-xs text-neutral-300">
                  {name}
                </span>
                <Switch
                  checked={!off}
                  onCheckedChange={(next) => void onToggleModel(name, next)}
                  aria-label={`${name} enabled`}
                />
              </li>
            );
          })}
          {customModels.map((name) => {
            const off = disabledModels.includes(name);
            return (
              <li
                key={name}
                className={cn(
                  "flex items-center gap-2 rounded-xl bg-white/[0.03] px-3 py-1.5",
                  off && "opacity-60",
                )}
              >
                <span className="min-w-0 flex-1 truncate text-xs text-neutral-300">
                  {name}
                </span>
                <Switch
                  checked={!off}
                  onCheckedChange={(next) => void onToggleModel(name, next)}
                  aria-label={`${name} enabled`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${name}`}
                  disabled={busy}
                  onClick={() => void remove(name)}
                >
                  <XIcon />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {adding ? (
        <div className="mt-2">
          <div className="flex items-center gap-2">
            <Input
              value={draft}
              autoComplete="off"
              spellCheck={false}
              aria-label="Custom model id"
              placeholder="Type a model id"
              onChange={(event) => {
                setDraft(event.target.value);
                setDuplicate(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void add();
                if (event.key === "Escape") {
                  setAdding(false);
                  setDraft("");
                  setDuplicate(false);
                }
              }}
              className="flex-1"
            />
            <Button
              type="button"
              size="sm"
              disabled={draft.trim() === "" || busy}
              onClick={() => void add()}
            >
              Add
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setAdding(false);
                setDraft("");
                setDuplicate(false);
              }}
            >
              Cancel
            </Button>
          </div>
          {duplicate ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Already listed for {provider.label}.
            </p>
          ) : null}
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() => setAdding(true)}
        >
          <PlusIcon />
          Add custom model
        </Button>
      )}
    </div>
  );
}
