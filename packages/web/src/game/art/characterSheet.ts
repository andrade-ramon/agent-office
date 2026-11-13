import { CanvasSource, Rectangle, Texture } from 'pixi.js';
import type { Variant } from '../variant';
import { FRAME_H, FRAME_W, drawCharacter, poseKey, type Pose } from './characterDraw';
import { OUTLINE, Painter, makeCanvas, outlineRegion } from './painter';

const COLS = 10;
const ROWS = 9;

/**
 * Atlas de poses de uma variante de personagem. As poses são desenhadas sob
 * demanda e reaproveitadas por todos os personagens com a mesma aparência.
 */
export class CharacterSheet {
  refs = 0;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly source: CanvasSource;
  private readonly frames = new Map<string, Texture>();
  private next = 0;

  constructor(readonly variant: Variant) {
    const { canvas, ctx } = makeCanvas(COLS * FRAME_W, ROWS * FRAME_H);
    this.canvas = canvas;
    this.ctx = ctx;
    this.source = new CanvasSource({ resource: canvas, scaleMode: 'nearest' });
  }

  frame(pose: Pose): Texture {
    const key = poseKey(pose);
    const cached = this.frames.get(key);
    if (cached) return cached;
    // Atlas cheio (não deve acontecer): reaproveita a última célula.
    const index = Math.min(this.next, COLS * ROWS - 1);
    this.next++;
    const x = (index % COLS) * FRAME_W;
    const y = Math.floor(index / COLS) * FRAME_H;
    this.ctx.clearRect(x, y, FRAME_W, FRAME_H);
    drawCharacter(new Painter(this.ctx, x, y), this.variant, pose);
    outlineRegion(this.ctx, x, y, FRAME_W, FRAME_H, OUTLINE);
    this.source.update();
    const texture = new Texture({ source: this.source, frame: new Rectangle(x, y, FRAME_W, FRAME_H) });
    this.frames.set(key, texture);
    return texture;
  }

  destroy(): void {
    for (const t of this.frames.values()) t.destroy(false);
    this.frames.clear();
    this.source.destroy();
  }
}

const sheets = new Map<string, CharacterSheet>();

export function acquireSheet(v: Variant): CharacterSheet {
  let sheet = sheets.get(v.id);
  if (!sheet) {
    sheet = new CharacterSheet(v);
    sheets.set(v.id, sheet);
  }
  sheet.refs++;
  return sheet;
}

export function releaseSheet(sheet: CharacterSheet): void {
  sheet.refs--;
  if (sheet.refs > 0) return;
  sheets.delete(sheet.variant.id);
  sheet.destroy();
}

export function destroyAllSheets(): void {
  for (const sheet of sheets.values()) sheet.destroy();
  sheets.clear();
}
