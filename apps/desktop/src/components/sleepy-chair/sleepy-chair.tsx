import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { createScene, hitTest, poke, render, step, type Scene } from "./scene";

/** Frames per second. Stepped on purpose: it reads as pixel art, and it is cheap. */
const FPS = 20;
/** Where the snore is mid-flight when motion is reduced. */
const STILL_TIME = 3.1;

// A hard 1px edge keeps the words legible over the stars; it is not a drop shadow.
const LABEL = "pointer-events-none absolute bottom-3 left-4 text-sm font-medium text-neutral-200 [text-shadow:0_1px_0_rgb(0_0_0/0.7)]"; // taste-skill-ignore: legibility edge on art, not elevation.

export interface SleepyChairProps {
  /** The words under the picture. Always visible. */
  label?: string;
  className?: string;
}

/**
 * The "nothing is running" banner: a pixel night sky with a black chair
 * asleep under the moon. Fills whatever box it is given; the art-pixel size
 * follows the box height so it stays crisp from a small card to a wide band.
 * Hover moves the stars, click the chair / the moon / the sky.
 */
export function SleepyChair({
  label = "Nothing running",
  className,
}: SleepyChairProps): React.ReactElement {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!box || !canvas || !ctx) return;

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let scene: Scene | null = null;
    let image: ImageData | null = null;
    let pixels: Uint32Array | null = null;
    let cell = 3;
    let frame = 0;
    let last = 0;
    let acc = 0;
    let visible = true;

    const draw = () => {
      if (!scene || !image || !pixels) return;
      render(scene, pixels);
      ctx.putImageData(image, 0, 0);
    };

    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      acc += dt;
      if (acc < 1 / FPS || !scene) return;
      step(scene, acc);
      acc = 0;
      draw();
    };

    const start = () => {
      if (frame || motion.matches || !visible || document.hidden) return;
      last = performance.now();
      frame = requestAnimationFrame(tick);
    };

    const layout = () => {
      const { width, height } = box.getBoundingClientRect();
      if (width < 8 || height < 8) return;
      // About 90 art pixels tall, never smaller than 2 screen pixels each.
      cell = Math.min(8, Math.max(2, Math.round(height / 90)));
      const gw = Math.ceil(width / cell);
      const gh = Math.ceil(height / cell);
      canvas.width = gw;
      canvas.height = gh;
      canvas.style.width = `${gw * cell}px`;
      canvas.style.height = `${gh * cell}px`;
      // Keep the chair's feet clear of the label strip (about 30 screen pixels).
      const reserve = Math.ceil(30 / cell);
      scene = createScene(gw, gh, motion.matches ? STILL_TIME : (scene?.time ?? 0), reserve);
      image = ctx.createImageData(gw, gh);
      pixels = new Uint32Array(image.data.buffer);
      if (motion.matches) {
        // One still frame with the snore already in the air.
        for (let t = 0; t < STILL_TIME; t += 0.2) step(scene, 0.2);
        scene.time = STILL_TIME;
      }
      draw();
    };

    const toGrid = (event: PointerEvent) => {
      const rect = box.getBoundingClientRect();
      return { x: (event.clientX - rect.left) / cell, y: (event.clientY - rect.top) / cell };
    };

    const onMove = (event: PointerEvent) => {
      if (!scene || motion.matches) return;
      const at = toGrid(event);
      scene.pointer = at;
      box.style.cursor = hitTest(scene, at.x, at.y) === "sky" ? "" : "pointer";
    };
    const onLeave = () => {
      if (scene) scene.pointer = null;
      box.style.cursor = "";
    };
    const onDown = (event: PointerEvent) => {
      if (!scene || motion.matches) return;
      const at = toGrid(event);
      poke(scene, at.x, at.y);
      draw();
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    const onMotion = () => {
      stop();
      layout();
      start();
    };

    layout();
    start();
    const resize = new ResizeObserver(() => {
      layout();
      start();
    });
    resize.observe(box);
    const seen = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      if (visible) start();
      else stop();
    });
    seen.observe(box);
    box.addEventListener("pointermove", onMove);
    box.addEventListener("pointerleave", onLeave);
    box.addEventListener("pointerdown", onDown);
    document.addEventListener("visibilitychange", onVisibility);
    motion.addEventListener("change", onMotion);
    return () => {
      stop();
      resize.disconnect();
      seen.disconnect();
      box.removeEventListener("pointermove", onMove);
      box.removeEventListener("pointerleave", onLeave);
      box.removeEventListener("pointerdown", onDown);
      document.removeEventListener("visibilitychange", onVisibility);
      motion.removeEventListener("change", onMotion);
    };
  }, []);

  return (
    <div
      ref={boxRef}
      data-slot="sleepy-chair"
      className={cn(
        "relative isolate min-h-36 w-full touch-manipulation select-none overflow-hidden rounded-card bg-[#0d0d1c]",
        className,
      )}
    >
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="absolute left-0 top-0 [image-rendering:pixelated]"
      />
      <p className={LABEL}>{label}</p>
    </div>
  );
}
