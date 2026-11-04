import { describe, expect, it, vi } from "vitest";
import { drawResolvedLayers, type DrawImage } from "./canvas2d.js";
import type { ResolvedLayer } from "./curves.js";

function stubCtx() {
  return {
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    drawImage: vi.fn(),
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
  } as unknown as CanvasRenderingContext2D;
}

const cursorImage = { naturalWidth: 100, naturalHeight: 100 } as DrawImage;

function cursorLayer(hotspot: Record<string, number> = {}): ResolvedLayer {
  return {
    id: "cursor",
    type: "image",
    resolved: { x: 400, y: 300, rotation: 0.5, src: "cursor.png", scaleX: 100, scaleY: 100, ...hotspot },
  };
}

describe("canvas2d image hotspot", () => {
  it("draws the tip at the translated point so rotation pivots about it", () => {
    const ctx = stubCtx();
    const images = new Map([["cursor.png", cursorImage]]);
    drawResolvedLayers(ctx, 1920, 1080, [cursorLayer({ hotspotX: 0.14, hotspotY: 0.08 })], {
      width: 1920,
      height: 1080,
      images,
      t: 0,
    });
    expect(ctx.translate).toHaveBeenCalledWith(400, 300);
    expect(ctx.rotate).toHaveBeenCalledWith(0.5);
    const drawImage = ctx.drawImage as unknown as ReturnType<typeof vi.fn>;
    expect(drawImage).toHaveBeenCalledOnce();
    const [img, dx, dy, dw, dh] = drawImage.mock.calls[0] as [DrawImage, number, number, number, number];
    expect(img).toBe(cursorImage);
    expect(dx).toBeCloseTo(-14, 6);
    expect(dy).toBeCloseTo(-8, 6);
    expect(dw).toBe(100);
    expect(dh).toBe(100);
  });

  it("centres the image when no hotspot is set", () => {
    const ctx = stubCtx();
    const images = new Map([["cursor.png", cursorImage]]);
    drawResolvedLayers(ctx, 1920, 1080, [cursorLayer()], {
      width: 1920,
      height: 1080,
      images,
      t: 0,
    });
    expect(ctx.drawImage).toHaveBeenCalledWith(cursorImage, -50, -50, 100, 100);
  });
});
