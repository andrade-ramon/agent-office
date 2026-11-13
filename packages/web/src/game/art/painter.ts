/**
 * Utilitários de pixel art procedural sobre canvas 2D. Tudo é desenhado em
 * código — não há imagens externas.
 */

export const OUTLINE = '#272133';

export function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(w));
  canvas.height = Math.max(1, Math.ceil(h));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('canvas 2D indisponível');
  ctx.imageSmoothingEnabled = false;
  return { canvas, ctx };
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function parse(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function toHex(r: number, g: number, b: number): string {
  return `#${((1 << 24) | (clamp255(r) << 16) | (clamp255(g) << 8) | clamp255(b)).toString(16).slice(1)}`;
}

/** Clareia (amount > 0) ou escurece (amount < 0) uma cor; amount em [-1, 1]. */
export function shade(hex: string, amount: number): string {
  const [r, g, b] = parse(hex);
  if (amount >= 0) return toHex(r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount);
  const k = 1 + amount;
  // Escurecer puxa levemente para o azul: sombras mais "frias".
  return toHex(r * k, g * k, Math.min(255, b * k + 6 * -amount));
}

export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  return toHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = parse(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Gerador pseudoaleatório determinístico (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Pincel com origem deslocada: todas as coordenadas são em pixels inteiros. */
export class Painter {
  constructor(
    readonly ctx: CanvasRenderingContext2D,
    readonly ox = 0,
    readonly oy = 0,
  ) {}

  at(dx: number, dy: number): Painter {
    return new Painter(this.ctx, this.ox + dx, this.oy + dy);
  }

  rect(x: number, y: number, w: number, h: number, color: string): this {
    if (w <= 0 || h <= 0) return this;
    this.ctx.fillStyle = color;
    this.ctx.fillRect(this.ox + x, this.oy + y, w, h);
    return this;
  }

  px(x: number, y: number, color: string): this {
    return this.rect(x, y, 1, 1, color);
  }

  clear(x: number, y: number, w: number, h: number): this {
    this.ctx.clearRect(this.ox + x, this.oy + y, w, h);
    return this;
  }

  /** Contorno retangular de 1px. */
  frame(x: number, y: number, w: number, h: number, color: string): this {
    this.rect(x, y, w, 1, color);
    this.rect(x, y + h - 1, w, 1, color);
    this.rect(x, y + 1, 1, h - 2, color);
    this.rect(x + w - 1, y + 1, 1, h - 2, color);
    return this;
  }

  /** Linha de Bresenham. */
  line(x0: number, y0: number, x1: number, y1: number, color: string): this {
    let x = Math.round(x0);
    let y = Math.round(y0);
    const xe = Math.round(x1);
    const ye = Math.round(y1);
    const dx = Math.abs(xe - x);
    const dy = -Math.abs(ye - y);
    const sx = x < xe ? 1 : -1;
    const sy = y < ye ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.px(x, y, color);
      if (x === xe && y === ye) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
    return this;
  }

  /** Elipse preenchida; (cx, cy) é o centro e pode ser fracionário (.5). */
  ellipse(cx: number, cy: number, rx: number, ry: number, color: string): this {
    for (let y = Math.ceil(cy - ry); y <= Math.floor(cy + ry); y++) {
      const t = (y - cy) / ry;
      const half = rx * Math.sqrt(Math.max(0, 1 - t * t));
      const x0 = Math.round(cx - half);
      const x1 = Math.round(cx + half);
      this.rect(x0, y, Math.max(1, x1 - x0), 1, color);
    }
    return this;
  }

  /** Anel elíptico de 1px (aproximação por pontos). */
  ring(cx: number, cy: number, rx: number, ry: number, color: string, gapEvery = 0): this {
    const steps = Math.max(16, Math.round((rx + ry) * 4));
    let last = '';
    for (let i = 0; i < steps; i++) {
      if (gapEvery > 0 && Math.floor((i / steps) * gapEvery * 2) % 2 === 1) continue;
      const a = (i / steps) * Math.PI * 2;
      const x = Math.round(cx + Math.cos(a) * rx);
      const y = Math.round(cy + Math.sin(a) * ry);
      const id = `${x},${y}`;
      if (id === last) continue;
      last = id;
      this.px(x, y, color);
    }
    return this;
  }

  /** Desenha um bitmap de texto: cada caractere é procurado em `colors`. */
  bitmap(x: number, y: number, rows: readonly string[], colors: Record<string, string>): this {
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]!;
      for (let c = 0; c < row.length; c++) {
        const color = colors[row[c]!];
        if (color) this.px(x + c, y + r, color);
      }
    }
    return this;
  }
}

/**
 * Contorna a silhueta: todo pixel transparente vizinho (4 direções) de um
 * pixel opaco recebe a cor de contorno.
 */
export function outlineRegion(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string = OUTLINE,
): void {
  const img = ctx.getImageData(x, y, w, h);
  const d = img.data;
  const [r, g, b] = parse(color);
  const solid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) solid[i] = d[i * 4 + 3]! > 40 ? 1 : 0;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const i = py * w + px;
      if (solid[i]) continue;
      const near =
        (px > 0 && solid[i - 1]) ||
        (px < w - 1 && solid[i + 1]) ||
        (py > 0 && solid[i - w]) ||
        (py < h - 1 && solid[i + w]);
      if (near) {
        d[i * 4] = r;
        d[i * 4 + 1] = g;
        d[i * 4 + 2] = b;
        d[i * 4 + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, x, y);
}

/**
 * Cria um sprite com margem de 1px para o contorno. `draw` recebe um pincel
 * cuja origem (0,0) é o canto do conteúdo (o canvas tem cw+2 × ch+2).
 */
export function makeSprite(
  cw: number,
  ch: number,
  draw: (p: Painter) => void,
  outline: string | false = OUTLINE,
): HTMLCanvasElement {
  const { canvas, ctx } = makeCanvas(cw + 2, ch + 2);
  draw(new Painter(ctx, 1, 1));
  if (outline) outlineRegion(ctx, 0, 0, cw + 2, ch + 2, outline);
  return canvas;
}

/** Sprite sem margem nem contorno. */
export function makeFlat(w: number, h: number, draw: (p: Painter) => void): HTMLCanvasElement {
  const { canvas, ctx } = makeCanvas(w, h);
  draw(new Painter(ctx, 0, 0));
  return canvas;
}

export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Empacota vários canvases pequenos em um único atlas (prateleiras). */
export class AtlasBuilder {
  readonly canvas: HTMLCanvasElement;
  readonly frames = new Map<string, Frame>();
  private readonly ctx: CanvasRenderingContext2D;
  private cx = 1;
  private cy = 1;
  private rowH = 0;

  constructor(size = 512) {
    const { canvas, ctx } = makeCanvas(size, size);
    this.canvas = canvas;
    this.ctx = ctx;
  }

  add(name: string, sprite: HTMLCanvasElement): void {
    const w = sprite.width;
    const h = sprite.height;
    if (this.cx + w + 1 > this.canvas.width) {
      this.cx = 1;
      this.cy += this.rowH + 1;
      this.rowH = 0;
    }
    if (this.cy + h + 1 > this.canvas.height) throw new Error(`atlas cheio ao adicionar "${name}"`);
    this.ctx.drawImage(sprite, this.cx, this.cy);
    this.frames.set(name, { x: this.cx, y: this.cy, w, h });
    this.cx += w + 1;
    this.rowH = Math.max(this.rowH, h);
  }
}
