import type { Control, EffectSpec, Rig } from "@chair/effects";
import { RotateCcwIcon, SlidersHorizontalIcon, WavesIcon } from "lucide-react";
import { InfoHint } from "@/components/info-hint";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  RIG_SLIDERS,
  RIG_TOGGLES,
  controlRange,
  type ControlValue,
  type RigBake,
} from "./effect-model";

export const CARD = "rounded-[28px] bg-[#1a1a1a] text-neutral-100 shadow-raised ring-1 ring-white/8";

export function PanelTitle({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof WavesIcon;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 px-1">
      <Icon className="size-4 text-neutral-400" aria-hidden="true" />
      <h3 className="text-sm font-semibold tracking-wide text-neutral-100">{title}</h3>
      {children ? <div className="ml-auto flex items-center gap-2">{children}</div> : null}
    </div>
  );
}

function SliderRow({
  label,
  readout,
  ...slider
}: { label: string; readout: string } & React.ComponentProps<typeof Slider>) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-neutral-300">{label}</span>
        <span className="tabular-nums text-neutral-500">{readout}</span>
      </div>
      <Slider aria-label={label} getAriaLabel={() => label} {...slider} />
    </div>
  );
}

function scalar(value: number | readonly number[]): number {
  return Array.isArray(value) ? (value[0] ?? 0) : (value as number);
}

function VariableWidget({
  control,
  onDefault,
}: {
  control: Control;
  onDefault: (value: ControlValue) => void;
}) {
  if (control.type === "number") {
    const range = controlRange(control);
    const current = typeof control.default === "number" ? control.default : 0;
    return (
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Slider
          aria-label={`${control.label} default`}
          getAriaLabel={() => `${control.label} default`}
          min={range.min}
          max={range.max}
          step={range.step}
          value={current}
          onValueChange={(next) => onDefault(scalar(next))}
        />
        <span className="w-10 shrink-0 text-right text-xs tabular-nums text-neutral-500">
          {current.toFixed(range.step < 1 ? 2 : 0)}
        </span>
      </div>
    );
  }
  if (control.type === "bool") {
    return (
      <Switch
        checked={control.default === true}
        onCheckedChange={onDefault}
        aria-label={`${control.label} default`}
        className="ml-auto shrink-0"
      />
    );
  }
  if (control.type === "color") {
    const hex = typeof control.default === "string" ? control.default : "#ffffff";
    return (
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <input
          type="color"
          value={/^#[0-9a-fA-F]{6}$/.test(hex) ? hex : "#ffffff"}
          aria-label={`${control.label} picker`}
          onChange={(event) => onDefault(event.target.value)}
          className="size-7.5 shrink-0 cursor-pointer rounded-lg border border-white/10 bg-transparent p-0.5"
        />
        <Input
          size="sm"
          value={hex}
          aria-label={`${control.label} default`}
          onChange={(event) => onDefault(event.target.value)}
          className="w-24 shrink-0 font-mono text-xs"
        />
      </div>
    );
  }
  return (
    <Input
      size="sm"
      value={String(control.default)}
      aria-label={`${control.label} default`}
      onChange={(event) => onDefault(event.target.value)}
      className="min-w-0 flex-1"
    />
  );
}

/**
 * The variables the piece exposes in Resolve: name, control and default
 * per row, laid out like the inspector that will show them. Editing a
 * default retargets the published control, so the preview and the macro
 * agree on what the knob starts at.
 */
export function VariablesPanel({
  spec,
  onPatch,
}: {
  spec: EffectSpec | null;
  onPatch: (id: string, patch: { label?: string; default?: ControlValue }) => void;
}) {
  if (!spec) return null;
  const controls = spec.controls ?? [];
  return (
    <section aria-label="Variables" className={cn(CARD, "flex shrink-0 flex-col gap-3 p-4")}>
      <PanelTitle icon={SlidersHorizontalIcon} title="Variables">
        <span className="text-xs tabular-nums text-neutral-500">
          {controls.length} in Resolve
        </span>
        <InfoHint>Resolve shows these as the effect&apos;s inspector controls.</InfoHint>
      </PanelTitle>
      {controls.length > 0 ? (
        <div className="flex flex-col gap-2.5 px-1">
          {controls.map((control) => (
            <div key={`${spec.id}-${control.id}`} className="flex items-center gap-2.5">
              <Input
                size="sm"
                value={control.label}
                aria-label="Variable name"
                onChange={(event) => onPatch(control.id, { label: event.target.value })}
                className="w-32 shrink-0 text-xs"
              />
              <VariableWidget control={control} onDefault={(next) => onPatch(control.id, { default: next })} />
            </div>
          ))}
        </div>
      ) : (
        <p className="px-1 text-xs leading-5 text-neutral-500">
          This piece exposes no variables.
        </p>
      )}
    </section>
  );
}

/** The motion rig: re-simulates on every change and shows what it baked. */
export function RigPanel({
  rig,
  bake,
  onChange,
  onReset,
}: {
  rig: Rig | null;
  bake: RigBake;
  onChange: (patch: Partial<Rig>) => void;
  onReset: () => void;
}) {
  return (
    <section aria-label="Rig" className={cn(CARD, "flex shrink-0 flex-col gap-3 p-4")}>
      <PanelTitle icon={WavesIcon} title="Rig">
        {rig ? (
          <Badge variant="outline" size="sm" className="tabular-nums" aria-live="polite">
            {bake.keys} keys
          </Badge>
        ) : null}
      </PanelTitle>
      {rig ? (
        <>
          <div className="flex flex-col gap-3 px-1">
            {RIG_SLIDERS.map((field) => {
              const value = rig[field.key] ?? field.fallback;
              return (
                <SliderRow
                  key={field.key}
                  label={field.label}
                  readout={field.step < 1 ? value.toFixed(1) : String(Math.round(value))}
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  value={value}
                  onValueChange={(next) => onChange({ [field.key]: scalar(next) })}
                />
              );
            })}
            <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 pt-1">
              {RIG_TOGGLES.map((toggle) => (
                <label
                  key={toggle.key}
                  className="flex items-center justify-between gap-2 text-xs text-neutral-300"
                >
                  {toggle.label}
                  <Switch
                    aria-label={toggle.label}
                    checked={rig[toggle.key] !== false}
                    onCheckedChange={(checked) => onChange({ [toggle.key]: checked })}
                  />
                </label>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 px-1 text-xs text-neutral-500">
            <span className="tabular-nums">
              {bake.keys} keyframes baked from {bake.frames} frames
            </span>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="ml-auto text-neutral-400"
              onClick={onReset}
            >
              <RotateCcwIcon />
              Reset
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
}
