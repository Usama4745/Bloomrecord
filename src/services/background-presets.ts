import type { BackgroundPreset } from '@shared/recording-types';

type BuiltIn = Exclude<BackgroundPreset, 'custom'>;

/** Built-in replacement backgrounds, drawn procedurally so no image files ship with the app. */
export const BACKGROUND_PRESETS: Record<BuiltIn, { label: string; angle: number; stops: string[]; glow?: string }> = {
  aurora: { label: 'Aurora', angle: 135, stops: ['#2b1055', '#7597de', '#3fd1c3'], glow: 'rgba(255,255,255,0.18)' },
  sunset: { label: 'Sunset', angle: 160, stops: ['#ff7e5f', '#feb47b', '#ffd6a5'], glow: 'rgba(255,240,220,0.25)' },
  ocean: { label: 'Ocean', angle: 180, stops: ['#0f2027', '#203a43', '#2c5364'], glow: 'rgba(120,200,255,0.15)' },
  forest: { label: 'Forest', angle: 150, stops: ['#134e5e', '#2f7d5b', '#71b280'] },
  slate: { label: 'Slate', angle: 135, stops: ['#232526', '#414345'] },
  paper: { label: 'Paper', angle: 135, stops: ['#f5f1ea', '#e6dfd3'] },
};

export function presetCss(id: BuiltIn): string {
  const p = BACKGROUND_PRESETS[id];
  return `linear-gradient(${p.angle}deg, ${p.stops.join(', ')})`;
}

/** Paints a built-in preset onto a canvas context. */
export function drawPreset(ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, id: BuiltIn, w: number, h: number): void {
  const p = BACKGROUND_PRESETS[id];
  // CSS angle: 0deg points up, 90deg right.
  const rad = ((p.angle - 90) * Math.PI) / 180;
  const half = (Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad))) / 2;
  const cx = w / 2;
  const cy = h / 2;
  const g = ctx.createLinearGradient(cx - Math.cos(rad) * half, cy - Math.sin(rad) * half, cx + Math.cos(rad) * half, cy + Math.sin(rad) * half);
  p.stops.forEach((c, i) => g.addColorStop(p.stops.length === 1 ? 0 : i / (p.stops.length - 1), c));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  if (p.glow) {
    const r = ctx.createRadialGradient(w * 0.7, h * 0.25, 0, w * 0.7, h * 0.25, Math.max(w, h) * 0.6);
    r.addColorStop(0, p.glow);
    r.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = r;
    ctx.fillRect(0, 0, w, h);
  }
}

/** Rectangle that covers dst with src's aspect ratio (like CSS object-fit: cover), centered. */
export function coverRect(srcW: number, srcH: number, dstW: number, dstH: number): { x: number; y: number; w: number; h: number } {
  if (srcW <= 0 || srcH <= 0) return { x: 0, y: 0, w: dstW, h: dstH };
  const scale = Math.max(dstW / srcW, dstH / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: (dstW - w) / 2, y: (dstH - h) / 2, w, h };
}

/** Output size for processed camera video: the camera's size, capped to 1280px wide, even dimensions. */
export function processingSize(srcW: number, srcH: number, maxW = 1280): { width: number; height: number } {
  const w = srcW > 0 ? srcW : 1280;
  const h = srcH > 0 ? srcH : 720;
  const scale = Math.min(1, maxW / w);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(w * scale), height: even(h * scale) };
}
