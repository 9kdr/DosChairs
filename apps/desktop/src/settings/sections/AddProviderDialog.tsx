import { Dialog } from "@base-ui/react/dialog";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { CheckIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  ADD_PROVIDER_STEPS,
  applyKeyDraft,
  buildAddProviderResult,
  defaultProvider,
  isKeyDraftValid,
  resolveWizardStep,
  type AddProviderResult,
  type ProviderKeys,
} from "../add-provider";
import {
  isProviderId,
  PROVIDERS,
  providerLabel,
  type ProviderId,
} from "../providers";

type AddProviderDialogProps = {
  open: boolean;
  keys: ProviderKeys;
  /** The list opens the wizard here; otherwise the first keyless provider. */
  initialProvider?: ProviderId | null;
  onOpenChange: (open: boolean) => void;
  onAdd: (result: AddProviderResult) => Promise<void>;
};

/**
 * Add a provider, after T3 Code's AddProviderInstanceDialog: pick
 * the provider, then the key (Chair's sign-in). Paste-a-key
 * auto-detects the provider and switches the pick. The parent
 * renders this only while open, so state starts fresh each time.
 */
export function AddProviderDialog({
  open,
  keys,
  initialProvider,
  onOpenChange,
  onAdd,
}: AddProviderDialogProps) {
  const [step, setStep] = useState(0);
  const [provider, setProvider] = useState<ProviderId>(
    initialProvider ?? defaultProvider(keys),
  );
  const [keyDraft, setKeyDraft] = useState("");
  const [shown, setShown] = useState(false);
  const [switchedFrom, setSwitchedFrom] = useState<ProviderId | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const keyValid = isKeyDraftValid(keyDraft);
  const draft = applyKeyDraft(keyDraft, provider);
  const label = providerLabel(provider);
  const lastStep = ADD_PROVIDER_STEPS.length - 1;

  const pickProvider = (next: ProviderId) => {
    setProvider(next);
    setKeyError(null);
    setSwitchedFrom(null);
  };

  const goTo = (requested: number) => {
    setKeyError(null);
    setStep(resolveWizardStep(requested));
  };

  const onKeyChange = (value: string) => {
    setKeyDraft(value);
    setKeyError(null);
    if (value.trim() === "") {
      setSwitchedFrom(null);
      return;
    }
    const applied = applyKeyDraft(value, provider);
    if (applied.switched) {
      setSwitchedFrom(provider);
      setProvider(applied.provider);
    }
  };

  const finish = async () => {
    const result = buildAddProviderResult({ provider, key: keyDraft });
    if (result == null) {
      setKeyError("Paste a key first.");
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      await onAdd(result);
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/70 transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          aria-label="Add provider"
          className={/* taste-skill-ignore: shadow-2xl, a modal dialog is a real overlay, which the rule allows. */ "fixed top-1/2 left-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-[#161616] p-6 shadow-2xl ring-1 ring-white/10 transition-[scale,opacity] duration-150 data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0"}
        >
          <Dialog.Title className="text-base font-semibold text-neutral-100">
            Add provider
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-neutral-400">
            Pick a provider and paste its key.
          </Dialog.Description>

          <ol
            aria-label="Setup progress"
            className="mt-4 grid auto-cols-fr grid-flow-col gap-1 rounded-xl bg-white/[0.03] p-1 ring-1 ring-white/[0.06]"
          >
            {ADD_PROVIDER_STEPS.map((name, index) => (
              <li key={name} className="min-w-0">
                <button
                  type="button"
                  onClick={() => goTo(index)}
                  aria-current={index === step ? "step" : undefined}
                  aria-label={`${name}, step ${index + 1}`}
                  className={cn(
                    "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-white/40",
                    index === step &&
                      "bg-white/[0.06] ring-1 ring-white/[0.08] ring-inset hover:bg-white/[0.06]",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "grid size-5 shrink-0 place-items-center rounded-full text-xs font-medium ring-1",
                      index < step
                        ? "bg-neutral-100 text-neutral-950 ring-neutral-100"
                        : index === step
                          ? "bg-white/[0.08] text-neutral-100 ring-white/40"
                          : "bg-white/[0.04] text-neutral-500 ring-white/10",
                    )}
                  >
                    {index < step ? (
                      <CheckIcon className="size-3.5" />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <span
                    className={cn(
                      "truncate text-sm font-medium",
                      index === step
                        ? "text-neutral-100"
                        : "text-neutral-400",
                    )}
                  >
                    {name}
                  </span>
                </button>
              </li>
            ))}
          </ol>
          {keyError != null ? (
            <p role="alert" className="mt-2 text-xs text-red-400">
              {keyError}
            </p>
          ) : null}

          <div className="mt-5">
            {step === 0 ? (
              <div>
                <p
                  id="add-provider-driver-label"
                  className="text-sm font-medium text-neutral-100"
                >
                  Provider
                </p>
                <RadioGroup
                  aria-labelledby="add-provider-driver-label"
                  value={provider}
                  onValueChange={(value) => {
                    if (isProviderId(value)) pickProvider(value);
                  }}
                  className="mt-2 grid grid-cols-1 gap-2"
                >
                  {PROVIDERS.map((option) => {
                    const hasKey = keys[option.id] != null;
                    return (
                      <Radio.Root
                        key={option.id}
                        value={option.id}
                        className="flex cursor-pointer items-center gap-3 rounded-xl bg-white/[0.03] px-4 py-3 text-left ring-1 ring-white/[0.06] outline-none hover:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-white/40 data-[checked]:bg-white/[0.05] data-[checked]:ring-white/40"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-3">
                            <span className="text-sm font-medium text-neutral-100">
                              {option.label}
                            </span>
                            <span className="shrink-0 text-xs text-neutral-500">
                              {hasKey ? "Key saved. Adding replaces it." : "No key"}
                            </span>
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-neutral-500">
                            {option.blurb}
                          </span>
                        </span>
                        <Radio.Indicator
                          aria-hidden="true"
                          className="grid size-5 shrink-0 place-items-center rounded-full bg-neutral-100 text-neutral-950"
                        >
                          <CheckIcon className="size-3.5" />
                        </Radio.Indicator>
                      </Radio.Root>
                    );
                  })}
                </RadioGroup>
              </div>
            ) : (
              <div>
                <label
                  htmlFor="add-provider-key"
                  className="text-sm font-medium text-neutral-100"
                >
                  {label} key
                </label>
                <div className="mt-2 flex items-center gap-2">
                  <Input
                    id="add-provider-key"
                    type={shown ? "text" : "password"}
                    value={keyDraft}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Paste a key"
                    onChange={(event) => onKeyChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void finish();
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
                </div>
                <p className="mt-2 text-xs text-neutral-500">
                  <KeyHint
                    draft={draft}
                    pickedLabel={label}
                    empty={!keyValid}
                    switchedFrom={
                      switchedFrom != null && switchedFrom !== provider
                        ? providerLabel(switchedFrom)
                        : null
                    }
                  />
                </p>
              </div>
            )}
          </div>

          <div className="mt-6 flex items-center justify-between gap-2">
            <Button
              type="button"
              variant={step === 0 ? "ghost" : "outline"}
              size="sm"
              disabled={busy}
              onClick={() => {
                if (step === 0) {
                  onOpenChange(false);
                  return;
                }
                goTo(step - 1);
              }}
            >
              {step === 0 ? "Cancel" : "Back"}
            </Button>
            {step < lastStep ? (
              <Button type="button" size="sm" onClick={() => goTo(step + 1)}>
                Next
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                loading={busy}
                onClick={() => void finish()}
              >
                Add provider
              </Button>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function KeyHint({
  draft,
  pickedLabel,
  empty,
  switchedFrom,
}: {
  draft: { provider: ProviderId; detected: ProviderId | null; switched: boolean };
  pickedLabel: string;
  empty: boolean;
  switchedFrom: string | null;
}) {
  if (empty) {
    return <>Detection never sends the key anywhere.</>;
  }
  const label = providerLabel(draft.provider);
  const article = label === "Anthropic" ? "an" : "a";
  if (draft.detected == null) {
    return (
      <>
        Unknown format. Filed under {pickedLabel}. Detection never sends the
        key anywhere.
      </>
    );
  }
  if (switchedFrom != null) {
    return (
      <>
        Looks like {article} {label} key. Switched from {switchedFrom}.
      </>
    );
  }
  return (
    <>
      Looks like {article} {label} key.
    </>
  );
}
