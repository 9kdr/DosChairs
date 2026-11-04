import { renderFrame, type EffectSpec } from "@chair/effects";
import { PauseIcon, PlayIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { stamp, type ControlValues } from "./effect-model";

export type PreviewHandle = {
  /** The frame at `at` seconds as a small PNG data URL, for the vision check. */
  capture: (at: number) => string | null;
};

const CHECKER = {
  backgroundImage: "repeating-conic-gradient(#1d1d1d 0% 25%, #161616 0% 50%)", // taste-skill-ignore: standard transparency grid, not decoration.
  backgroundSize: "22px 22px",
} as const;

/**
 * Live WebGL preview. A piece that plays once with a start and an end
 * gets a transport (play, scrub, timecode) looping a short demo; a
 * static or looping look just renders, frozen under reduced motion.
 * The clock lives here so a running preview re-renders only this
 * stage, not the panel.
 */
export function PreviewStage({
  spec,
  controls,
  timeSensitive,
  ref,
  className,
}: {
  spec: EffectSpec;
  controls: ControlValues;
  timeSensitive: boolean;
  ref?: Ref<PreviewHandle>;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<WebGL2RenderingContext | null>(null);
  const specRef = useRef(spec);
  const controlsRef = useRef(controls);
  specRef.current = spec;
  controlsRef.current = controls;
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(
    () => !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) {
      setUnsupported(true);
      return;
    }
    glRef.current = gl;
    return () => {
      glRef.current = null;
    };
  }, []);

  // A new spec starts from the top so the new look is seen from its first frame.
  useEffect(() => {
    setTime(0);
  }, [spec.id]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setTime((current) => {
        const next = current + dt;
        return next >= specRef.current.durationSec ? 0 : next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  useEffect(() => {
    const gl = glRef.current;
    if (gl) renderFrame(gl, spec, Math.min(time, spec.durationSec), controls);
  }, [spec, controls, time]);

  useImperativeHandle(ref, () => ({
    capture: (at) => {
      const gl = glRef.current;
      const source = canvasRef.current;
      if (!gl || !source) return null;
      renderFrame(gl, specRef.current, at, controlsRef.current);
      const out = document.createElement("canvas");
      out.width = 640;
      out.height = Math.round((640 * source.height) / source.width);
      const ctx = out.getContext("2d");
      if (!ctx) return null;
      ctx.fillStyle = "#141414";
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(source, 0, 0, out.width, out.height);
      return out.toDataURL("image/png");
    },
  }));

  const atEnd = time >= spec.durationSec - 1 / spec.fps;

  return (
    <div className={cn("flex min-h-0 flex-col gap-3", className)}>
      <div className="relative flex aspect-video min-h-56 w-full flex-none items-center justify-center overflow-hidden rounded-2xl">
        <div
          className="relative h-full max-w-full overflow-hidden rounded-2xl ring-1 ring-white/10"
          style={{ aspectRatio: `${spec.width} / ${spec.height}`, ...CHECKER }}
        >
          <canvas
            ref={canvasRef}
            width={spec.width}
            height={spec.height}
            aria-label={`Live preview of ${spec.name}`}
            role="img"
            className="size-full"
          />
          {unsupported ? (
            <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-neutral-400">
              This window has no WebGL2, so the live preview cannot draw.
            </p>
          ) : null}
        </div>
      </div>

      {timeSensitive ? (
        <div className="flex shrink-0 items-center gap-3 px-1">
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            aria-label={playing ? "Pause preview" : atEnd ? "Replay preview" : "Play preview"}
            onClick={() => {
              if (!playing && atEnd) setTime(0);
              setPlaying((current) => !current);
            }}
          >
            {playing ? <PauseIcon /> : atEnd ? <RotateCcwIcon /> : <PlayIcon />}
          </Button>
          <Slider
            aria-label="Scrub preview"
            min={0}
            max={spec.durationSec}
            step={1 / spec.fps}
            value={Math.min(time, spec.durationSec)}
            onValueChange={(value) => {
              setPlaying(false);
              setTime(Array.isArray(value) ? (value[0] ?? 0) : value);
            }}
            getAriaLabel={() => "Scrub preview"}
          />
          <span className="w-28 shrink-0 text-right text-xs tabular-nums text-neutral-400">
            {stamp(time)} <span className="text-neutral-600">/ {stamp(spec.durationSec)}</span>
          </span>
        </div>
      ) : null}
    </div>
  );
}
