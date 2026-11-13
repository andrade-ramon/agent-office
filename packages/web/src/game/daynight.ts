/**
 * Ciclo dia/noite: cores do céu e da luz ambiente a partir da hora (0–24).
 * Módulo puro.
 */

export type TimeMode = 'auto' | 'day' | 'night' | 'fast';

export const TIME_MODES: readonly TimeMode[] = ['auto', 'day', 'night', 'fast'];

export interface Ambient {
  hour: number;
  /** Cor do céu (parte de cima / parte de baixo da janela). */
  skyTop: number;
  skyBottom: number;
  /** Cor multiplicada sobre a cena. */
  tint: number;
  /** 0 = dia claro, 1 = noite fechada. */
  night: number;
}

interface Key {
  h: number;
  top: number;
  bottom: number;
  tint: number;
  night: number;
}

const KEYS: Key[] = [
  { h: 0, top: 0x0a0f24, bottom: 0x141b3c, tint: 0x6570b0, night: 1 },
  { h: 5, top: 0x10173a, bottom: 0x27305e, tint: 0x6b75b4, night: 0.95 },
  { h: 6.5, top: 0x6a7fc8, bottom: 0xf5a878, tint: 0xd8bcb0, night: 0.45 },
  { h: 8, top: 0x6fbcf5, bottom: 0xbfe6ff, tint: 0xfff3e2, night: 0 },
  { h: 12, top: 0x5fb4f5, bottom: 0xb4e2ff, tint: 0xffffff, night: 0 },
  { h: 16.5, top: 0x6ab6ee, bottom: 0xc8e4f5, tint: 0xfff1da, night: 0 },
  { h: 18, top: 0x7a6cb8, bottom: 0xf68f5c, tint: 0xe9bc9e, night: 0.4 },
  { h: 19.5, top: 0x262a62, bottom: 0x6b4a86, tint: 0x8c88c2, night: 0.82 },
  { h: 21, top: 0x0d1330, bottom: 0x1a2148, tint: 0x6672b2, night: 1 },
  { h: 24, top: 0x0a0f24, bottom: 0x141b3c, tint: 0x6570b0, night: 1 },
];

export function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

export function ambientAt(hour: number): Ambient {
  const h = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1]!.h <= h) i++;
  const a = KEYS[i]!;
  const b = KEYS[i + 1]!;
  const t = b.h === a.h ? 0 : (h - a.h) / (b.h - a.h);
  return {
    hour: h,
    skyTop: lerpColor(a.top, b.top, t),
    skyBottom: lerpColor(a.bottom, b.bottom, t),
    tint: lerpColor(a.tint, b.tint, t),
    night: a.night + (b.night - a.night) * t,
  };
}

/** Duração de um dia inteiro no modo "ciclo rápido". */
export const FAST_CYCLE_MS = 60_000;

/** Hora (0–24) para o modo escolhido. */
export function hourFor(mode: TimeMode, now: Date, fastElapsedMs = 0): number {
  switch (mode) {
    case 'day':
      return 12;
    case 'night':
      return 23;
    case 'fast':
      return (8 + (fastElapsedMs / FAST_CYCLE_MS) * 24) % 24;
    default:
      return now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
  }
}
