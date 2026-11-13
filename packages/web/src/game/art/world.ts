import { MAP_H, MAP_W, TILE, type Furniture, type OfficeLayout, type Rug } from '../layout';
import { AtlasBuilder, Painter, hash2, makeCanvas, makeFlat, makeSprite, rgba, rng, shade } from './painter';

/**
 * Arte do cenário: mapa base (pisos, paredes, tapetes, cadeiras) e o atlas de
 * móveis / efeitos. Tudo procedural.
 */

export const C = {
  void: '#11131b',
  cap: '#3b3451',
  capHi: '#585076',
  capLo: '#2a2439',
  wall: '#e6dac4',
  wallHi: '#f1e8d6',
  wallLo: '#d2c4aa',
  wallShadow: '#b7a88f',
  baseboard: '#7b6050',
  baseboardHi: '#96786a',
  wallServer: '#9eabbc',
  wallServerLo: '#8492a5',
  wallServerShadow: '#6f7c90',
  wood: ['#c4925f', '#bd8b59', '#ca9967'],
  woodLine: '#a3764a',
  woodKnot: '#94693f',
  server: '#465468',
  serverHi: '#54637a',
  serverLo: '#3a4658',
  carpet: '#516f94',
  carpetHi: '#5c7ba1',
  carpetLo: '#486488',
  library: '#5d7d66',
  libraryHi: '#698b72',
  libraryLo: '#53715c',
  copaA: '#ece2cd',
  copaB: '#dbcdb2',
  copaLine: '#c6b79a',
  deskTop: '#e9dfcc',
  deskTopHi: '#f6efe0',
  deskEdge: '#c9b999',
  deskFront: '#a89572',
  deskFrontLo: '#8a7858',
  metal: '#8a93a3',
  metalHi: '#b4bcc8',
  metalLo: '#5d6677',
  dark: '#262b36',
  darker: '#1a1e27',
  screenOff: '#141922',
  paper: '#f6f2e6',
  green: '#4f9d69',
  greenHi: '#6fbf7f',
  greenLo: '#357a50',
  pot: '#b5654a',
  potHi: '#cf7f61',
  wood2: '#8b5e3c',
  wood2Hi: '#a8774d',
  wood2Lo: '#6e4a2e',
} as const;

const BOOKS = ['#c8553d', '#3f7fbf', '#e3b23c', '#4f9d69', '#8e5aa8', '#d9d3c3', '#2f6f73', '#b5654a', '#e58fa3'];

export interface Placement {
  frame: string;
  x: number;
  y: number;
  z: number;
}

export interface Anchor {
  x: number;
  y: number;
  z: number;
}

export interface WorldArt {
  base: HTMLCanvasElement;
  atlas: AtlasBuilder;
  /** Móveis ordenados por profundidade junto com os personagens. */
  placements: Placement[];
  /** Decoração de parede (fica atrás de tudo que se move). */
  wall: Placement[];
  /** Tela do monitor de cada mesa (só as visíveis). */
  screens: Map<number, Anchor>;
  /** LED do monitor visto por trás. */
  deskLeds: Map<number, Anchor>;
  /** LEDs dos racks (pixels do mundo). */
  rackLeds: { x: number; y: number; z: number }[];
  windows: { x: number; y: number }[];
  clock: { x: number; y: number };
  whiteboard: { x: number; y: number };
  door: { x: number; y: number };
  tv: { x: number; y: number };
  globe: Anchor;
  towerLight: Anchor;
  dishWave: Anchor;
  crt: Anchor;
  arcade: Anchor;
  steam: Anchor[];
  lamps: { x: number; y: number }[];
}

// ─────────────────────────────── pisos e paredes ───────────────────────────────

function drawFloor(p: Painter, kind: string, tx: number, ty: number): void {
  const X = tx * TILE;
  const Y = ty * TILE;
  const h = hash2(tx, ty);
  switch (kind) {
    case 'server': {
      p.rect(X, Y, 16, 16, C.server);
      p.rect(X, Y, 16, 1, C.serverHi);
      p.rect(X, Y, 1, 16, C.serverHi);
      p.rect(X, Y + 15, 16, 1, C.serverLo);
      p.rect(X + 15, Y, 1, 16, C.serverLo);
      if (h % 4 === 0) {
        for (let i = 0; i < 3; i++) p.rect(X + 4, Y + 4 + i * 3, 8, 1, C.serverLo);
      } else {
        for (const [dx, dy] of [[3, 3], [12, 3], [3, 12], [12, 12]] as const) p.px(X + dx, Y + dy, C.serverLo);
      }
      break;
    }
    case 'carpet':
    case 'library': {
      const base = kind === 'carpet' ? C.carpet : C.library;
      const hi = kind === 'carpet' ? C.carpetHi : C.libraryHi;
      const lo = kind === 'carpet' ? C.carpetLo : C.libraryLo;
      p.rect(X, Y, 16, 16, base);
      const r = rng(h);
      for (let i = 0; i < 14; i++) {
        p.px(X + Math.floor(r() * 16), Y + Math.floor(r() * 16), i % 2 ? hi : lo);
      }
      if (kind === 'library') {
        p.px(X + 8, Y + 7, hi).px(X + 7, Y + 8, hi).px(X + 9, Y + 8, hi).px(X + 8, Y + 9, hi);
      }
      break;
    }
    case 'copa': {
      const light = (tx + ty) % 2 === 0;
      p.rect(X, Y, 16, 16, light ? C.copaA : C.copaB);
      p.rect(X, Y + 15, 16, 1, C.copaLine);
      p.rect(X + 15, Y, 1, 16, C.copaLine);
      p.rect(X, Y, 15, 1, light ? '#f6efe0' : '#e4d7be');
      break;
    }
    default: {
      for (let r = 0; r < 4; r++) {
        const row = ty * 4 + r;
        const hh = hash2(tx >> 1, row);
        const yy = Y + r * 4;
        p.rect(X, yy, 16, 4, C.wood[hh % 3]!);
        p.rect(X, yy + 3, 16, 1, C.woodLine);
        const off = (row * 9) % 24;
        for (let gx = X; gx < X + 16; gx++) {
          if ((gx + off) % 24 === 0) p.rect(gx, yy, 1, 3, C.woodLine);
        }
        const hk = hash2(tx, row);
        if (hk % 19 === 0) p.rect(X + 3 + (hk % 9), yy + 1, 2, 1, C.woodKnot);
      }
    }
  }
}

function drawBase(office: OfficeLayout): HTMLCanvasElement {
  const { canvas, ctx } = makeCanvas(MAP_W * TILE, MAP_H * TILE);
  const p = new Painter(ctx);
  const kindAt = (x: number, y: number): string =>
    x < 0 || y < 0 || x >= office.w || y >= office.h ? 'out' : office.tiles[y * office.w + x]!;
  const solidAt = (x: number, y: number): boolean => {
    const k = kindAt(x, y);
    return k === 'cap' || k === 'face' || k === 'out';
  };

  for (let ty = 0; ty < office.h; ty++) {
    for (let tx = 0; tx < office.w; tx++) {
      const X = tx * TILE;
      const Y = ty * TILE;
      const kind = kindAt(tx, ty);
      if (kind === 'floor') {
        drawFloor(p, office.floors[ty * office.w + tx]!, tx, ty);
      } else if (kind === 'face' || kind === 'door') {
        // Descobre o tipo de piso logo abaixo da parede (define a cor).
        let by = ty;
        while (kindAt(tx, by) === 'face' || kindAt(tx, by) === 'door') by++;
        const below = kindAt(tx, by) === 'floor' ? office.floors[by * office.w + tx]! : 'wood';
        const server = below === 'server';
        const wall = server ? C.wallServer : C.wall;
        const lo = server ? C.wallServerLo : C.wallLo;
        const shadow = server ? C.wallServerShadow : C.wallShadow;
        p.rect(X, Y, 16, 16, wall);
        const top = kindAt(tx, ty - 1) === 'cap';
        const bottom = kindAt(tx, ty + 1) !== 'face' && kindAt(tx, ty + 1) !== 'door';
        if (top) {
          p.rect(X, Y, 16, 2, shadow);
          p.rect(X, Y + 2, 16, 1, lo);
        }
        if (server) {
          p.rect(X + 15, Y, 1, 16, lo);
          if (!top) p.rect(X, Y + 3, 16, 1, lo);
        } else if (bottom && !top) {
          p.rect(X, Y + 4, 16, 1, lo);
          p.rect(X, Y + 5, 16, 1, C.wallHi);
        }
        if (bottom) {
          p.rect(X, Y + 12, 16, 4, server ? '#5d6a7e' : C.baseboard);
          p.rect(X, Y + 12, 16, 1, server ? '#7886a0' : C.baseboardHi);
        }
      } else if (kind === 'cap') {
        p.rect(X, Y, 16, 16, C.cap);
        const s = solidAt(tx, ty + 1) && kindAt(tx, ty + 1) !== 'out';
        if (!solidAt(tx - 1, ty)) p.rect(X, Y, 2, 16, C.capHi);
        if (!solidAt(tx + 1, ty)) p.rect(X + 14, Y, 2, 16, C.capLo);
        if (!solidAt(tx, ty - 1)) p.rect(X, Y, 16, 2, C.capHi);
        if (kindAt(tx, ty + 1) === 'face' || kindAt(tx, ty + 1) === 'door') p.rect(X, Y + 14, 16, 2, C.capLo);
        else if (!s && kindAt(tx, ty + 1) !== 'out') {
          // Fim de parede visto de frente: mostra a espessura.
          p.rect(X, Y + 10, 16, 6, C.capLo);
          p.rect(X, Y + 10, 16, 1, C.capHi);
        }
        if (kindAt(tx, ty - 1) === 'out') p.rect(X, Y, 16, 1, C.capLo);
        if (kindAt(tx - 1, ty) === 'out') p.rect(X, Y, 1, 16, C.capLo);
        if (kindAt(tx + 1, ty) === 'out') p.rect(X + 15, Y, 1, 16, C.capLo);
        if (kindAt(tx, ty + 1) === 'out') p.rect(X, Y + 15, 16, 1, C.capLo);
      }
    }
  }

  // Sombras das paredes sobre o piso.
  for (let ty = 0; ty < office.h; ty++) {
    for (let tx = 0; tx < office.w; tx++) {
      if (kindAt(tx, ty) !== 'floor') continue;
      const X = tx * TILE;
      const Y = ty * TILE;
      const north = kindAt(tx, ty - 1);
      if (north === 'face' || north === 'cap') {
        p.rect(X, Y, 16, 3, 'rgba(20,16,30,0.20)');
        p.rect(X, Y + 3, 16, 2, 'rgba(20,16,30,0.09)');
      }
      if (kindAt(tx - 1, ty) === 'cap') p.rect(X, Y, 2, 16, 'rgba(20,16,30,0.12)');
    }
  }

  // Sombras de contato dos móveis sólidos.
  for (const f of office.furniture) {
    if (f.kind === 'chair' || f.kind === 'stool' || f.kind === 'sofa' || f.kind === 'puff') continue;
    const y = (f.y + f.h) * TILE;
    if (kindAt(f.x, f.y + f.h) !== 'floor') continue;
    p.rect(f.x * TILE + 1, y, f.w * TILE - 2, 2, 'rgba(20,16,30,0.16)');
  }

  for (const rug of office.rugs) drawRug(p, rug);

  // Placa de saída sobre a porta.
  const door = office.decor.find((d) => d.kind === 'door');
  if (door) {
    const sx = door.x * TILE + 8;
    p.rect(sx, 9, 16, 6, '#1e3b2c');
    p.rect(sx + 1, 10, 14, 4, '#3fbf7a');
    p.rect(sx + 3, 11, 4, 2, '#eafff2');
    p.px(sx + 8, 11, '#eafff2').px(sx + 9, 12, '#eafff2').px(sx + 10, 11, '#eafff2').px(sx + 11, 12, '#eafff2');
  }

  // Cadeiras e bancos (ficam sempre atrás de quem senta).
  for (const f of office.furniture) {
    if (f.kind === 'chair') {
      const sprite = chairSprite(f.dir, f.variant);
      const [dx, dy] = f.dir === 'down' ? [1, 0] : f.dir === 'up' ? [1, 1] : f.dir === 'right' ? [0, 1] : [1, 1];
      ctx.drawImage(sprite, f.x * TILE + dx, f.y * TILE + dy);
    } else if (f.kind === 'stool') {
      ctx.drawImage(stoolSprite(f.variant), f.x * TILE + 2, f.y * TILE + 2);
    }
  }
  return canvas;
}

function drawRug(p: Painter, rug: Rug): void {
  const X = rug.x * TILE;
  const Y = rug.y * TILE;
  const w = rug.w * TILE;
  const h = rug.h * TILE;
  switch (rug.style) {
    case 'mat': {
      p.rect(X + 2, Y + 3, w - 4, h - 6, '#5e3a2e');
      p.rect(X + 3, Y + 4, w - 6, h - 8, '#8a5540');
      for (let x = X + 5; x < X + w - 5; x += 3) p.rect(x, Y + 6, 1, h - 12, '#74452f');
      break;
    }
    case 'web': {
      const cx = X + w / 2 - 0.5;
      const cy = Y + h / 2 - 0.5;
      p.ellipse(cx, cy, w / 2 - 2, h / 2 - 2, '#232d52');
      p.ellipse(cx, cy, w / 2 - 4, h / 2 - 4, '#2f3d6e');
      p.ellipse(cx, cy, w / 2 - 12, h / 2 - 9, '#3a4d86');
      p.ring(cx, cy, w / 2 - 8, h / 2 - 7, '#5f86c8');
      p.ring(cx, cy, w / 2 - 20, h / 2 - 15, '#5fd0e0', 12);
      break;
    }
    case 'lounge': {
      p.rect(X + 2, Y + 2, w - 4, h - 4, '#8f4b3c');
      p.rect(X + 4, Y + 4, w - 8, h - 8, '#b9684e');
      p.frame(X + 6, Y + 6, w - 12, h - 12, '#e3b56a');
      for (let x = X + 10; x < X + w - 10; x += 8) {
        p.px(x, Y + 10, '#e3b56a').px(x + 1, Y + 11, '#e3b56a').px(x, Y + h - 11, '#e3b56a').px(x + 1, Y + h - 12, '#e3b56a');
      }
      for (let x = X + 3; x < X + w - 3; x += 2) p.px(x, Y + 1, '#d9a070').px(x, Y + h - 2, '#d9a070');
      break;
    }
    case 'library': {
      p.rect(X + 1, Y + 2, w - 2, h - 4, '#6e3038');
      p.rect(X + 3, Y + 4, w - 6, h - 8, '#8f4048');
      p.frame(X + 5, Y + 6, w - 10, h - 12, '#d9a45a');
      for (let x = X + 2; x < X + w - 2; x += 2) p.px(x, Y + 1, '#c08a5a').px(x, Y + h - 2, '#c08a5a');
      break;
    }
    case 'meeting': {
      p.rect(X + 3, Y + 3, w - 6, h - 6, '#5f80a8');
      p.frame(X + 3, Y + 3, w - 6, h - 6, '#7d9cc2');
      p.frame(X + 6, Y + 6, w - 12, h - 12, '#587aa3');
      break;
    }
  }
}

// ─────────────────────────────── cadeiras ───────────────────────────────

const CHAIR_COLORS = [
  { seat: '#4f72ad', back: '#3d5a8c' },
  { seat: '#9a525e', back: '#743a46' },
  { seat: '#b98557', back: '#96683f' },
];

const chairCache = new Map<string, HTMLCanvasElement>();

function chairSprite(dir: string, style: number): HTMLCanvasElement {
  const id = `${dir}-${style}`;
  const cached = chairCache.get(id);
  if (cached) return cached;
  const col = CHAIR_COLORS[style % CHAIR_COLORS.length]!;
  const base = '#3a3f4d';
  let sprite: HTMLCanvasElement;
  if (dir === 'down') {
    sprite = makeSprite(12, 14, (p) => {
      p.rect(1, 0, 10, 6, col.back).rect(1, 0, 10, 1, shade(col.back, 0.25));
      p.rect(0, 6, 12, 5, col.seat).rect(0, 6, 12, 1, shade(col.seat, 0.25));
      p.rect(5, 11, 2, 2, base).rect(2, 13, 3, 1, base).rect(7, 13, 3, 1, base);
    });
  } else if (dir === 'up') {
    sprite = makeSprite(12, 13, (p) => {
      p.rect(0, 1, 12, 7, col.seat).rect(0, 1, 12, 1, shade(col.seat, 0.25));
      p.rect(5, 8, 2, 3, base).rect(2, 11, 3, 1, base).rect(7, 11, 3, 1, base);
    });
  } else {
    const flip = dir === 'left';
    sprite = makeSprite(13, 13, (p) => {
      const bx = flip ? 10 : 0;
      const sx = flip ? 0 : 2;
      p.rect(bx, 0, 3, 10, col.back).rect(bx, 0, 3, 1, shade(col.back, 0.25));
      p.rect(sx, 5, 11, 5, col.seat).rect(sx, 5, 11, 1, shade(col.seat, 0.25));
      p.rect(6, 10, 2, 2, base).rect(3, 12, 8, 1, base);
    });
  }
  chairCache.set(id, sprite);
  return sprite;
}

function chairBackSprite(style: number): HTMLCanvasElement {
  const col = CHAIR_COLORS[style % CHAIR_COLORS.length]!;
  return makeSprite(10, 8, (p) => {
    p.rect(0, 0, 10, 8, col.back).rect(0, 0, 10, 1, shade(col.back, 0.3));
    p.rect(1, 2, 8, 1, shade(col.back, -0.15)).rect(1, 5, 8, 1, shade(col.back, -0.15));
  });
}

function stoolSprite(style: number): HTMLCanvasElement {
  const id = `stool-${style}`;
  const cached = chairCache.get(id);
  if (cached) return cached;
  const seat = style === 3 ? '#d4694c' : '#d9a25a';
  const sprite = makeSprite(10, 11, (p) => {
    p.rect(1, 5, 1, 6, C.metalLo).rect(8, 5, 1, 6, C.metalLo).rect(4, 5, 2, 5, C.metalLo);
    p.rect(1, 8, 8, 1, C.metal);
    p.ellipse(4.5, 2.5, 5, 2.6, seat);
    p.rect(2, 1, 6, 1, shade(seat, 0.3));
  });
  chairCache.set(id, sprite);
  return sprite;
}

// ─────────────────────────────── móveis ───────────────────────────────

function podSprite(seed: number): HTMLCanvasElement {
  return makeSprite(64, 32, (p) => {
    p.rect(0, 0, 64, 27, C.deskTop).rect(0, 0, 64, 1, C.deskTopHi);
    p.rect(32, 0, 1, 27, C.deskEdge);
    p.rect(0, 27, 64, 4, C.deskFront).rect(0, 27, 64, 1, C.deskEdge).rect(0, 31, 64, 1, C.deskFrontLo);
    p.rect(0, 28, 2, 4, C.deskFrontLo).rect(62, 28, 2, 4, C.deskFrontLo).rect(31, 28, 2, 4, C.deskFrontLo);
    // divisória baixa entre as duas fileiras
    p.rect(0, 14, 64, 3, '#5d6a84').rect(0, 14, 64, 1, '#7c8aa8');
    for (let col = 0; col < 4; col++) {
      const X = col * 16;
      if (col % 2 === 0) {
        // monitor visto por trás (fileira de cima)
        p.rect(X + 2, 3, 12, 9, '#3a4151').rect(X + 2, 3, 12, 1, '#515b70').rect(X + 2, 11, 12, 1, '#2c323f');
        p.rect(X + 7, 6, 2, 2, '#66718a');
        p.rect(X + 6, 12, 4, 2, '#2a2f3a');
        p.rect(X + 4, 0, 8, 2, '#c3c8d2').rect(X + 4, 0, 8, 1, '#dfe3ea');
        // objetos na mesa de baixo
        const v = (seed + col) % 5;
        if (v === 0) {
          p.rect(X + 5, 20, 4, 4, '#f4f1e8').rect(X + 6, 21, 2, 1, '#7a4a2e').px(X + 9, 21, '#f4f1e8');
        } else if (v === 1) {
          p.rect(X + 3, 19, 7, 6, C.paper).rect(X + 5, 20, 7, 6, '#fffdf5');
          p.rect(X + 6, 22, 5, 1, '#b8b2a2').rect(X + 6, 24, 4, 1, '#b8b2a2');
        } else if (v === 2) {
          p.rect(X + 5, 22, 5, 3, C.pot).rect(X + 5, 22, 5, 1, C.potHi);
          p.rect(X + 4, 18, 7, 4, C.green).rect(X + 5, 17, 3, 2, C.greenHi).px(X + 9, 19, C.greenHi);
        } else if (v === 3) {
          p.rect(X + 3, 21, 9, 2, BOOKS[0]!).rect(X + 4, 19, 8, 2, BOOKS[1]!).rect(X + 3, 23, 9, 2, BOOKS[2]!);
          p.rect(X + 3, 22, 9, 1, shade(BOOKS[0]!, -0.2));
        } else {
          p.rect(X + 4, 23, 5, 1, C.metalLo).rect(X + 6, 19, 1, 4, C.metalLo);
          p.rect(X + 6, 18, 5, 2, '#e9b44c').rect(X + 7, 20, 3, 1, '#fff2b8');
        }
      } else {
        // monitor de frente (fileira de baixo)
        p.rect(X + 2, 4, 12, 10, C.dark).rect(X + 3, 5, 10, 7, C.screenOff);
        p.rect(X + 6, 14, 4, 4, C.darker).rect(X + 5, 17, 6, 1, '#343a47');
        p.rect(X + 3, 20, 9, 3, '#c6cad4').rect(X + 3, 20, 9, 1, '#e2e5ec');
        p.px(X + 4, 21, '#8a90a0').px(X + 6, 21, '#8a90a0').px(X + 8, 21, '#8a90a0').px(X + 10, 21, '#8a90a0');
        p.rect(X + 13, 21, 2, 2, '#e2e5ec');
      }
    }
  });
}

function screenSprites(): HTMLCanvasElement[] {
  const out: HTMLCanvasElement[] = [];
  out.push(
    makeFlat(10, 7, (p) => {
      p.rect(0, 0, 10, 7, C.screenOff).px(7, 1, '#232a38').px(8, 2, '#232a38');
    }),
  );
  out.push(
    makeFlat(10, 7, (p) => {
      p.rect(0, 0, 10, 7, '#17233a').rect(4, 2, 2, 3, '#3d5c8a').rect(3, 3, 4, 1, '#3d5c8a');
    }),
  );
  const cols = ['#6fe3a0', '#7fb2ff', '#ffd166', '#ff8fb1'];
  for (let f = 0; f < 3; f++) {
    out.push(
      makeFlat(10, 7, (p) => {
        p.rect(0, 0, 10, 7, '#10213a');
        for (let row = 0; row < 3; row++) {
          const k = (row + f) % 4;
          const indent = (row + f) % 3;
          const len = 3 + ((row * 2 + f * 3) % 4);
          p.rect(1 + indent, 1 + row * 2, Math.min(len, 8 - indent), 1, cols[k]!);
          if (len < 5) p.rect(2 + indent + len, 1 + row * 2, 2, 1, cols[(k + 2) % 4]!);
        }
      }),
    );
  }
  return out;
}

function rackSprite(v: number): HTMLCanvasElement {
  return makeSprite(14, 30, (p) => {
    p.rect(0, 0, 14, 4, '#4a5468').rect(0, 0, 14, 1, '#66728b');
    p.rect(0, 4, 14, 26, '#262c38').rect(13, 4, 1, 26, '#1b2029').rect(0, 4, 1, 26, '#323a49');
    for (let u = 0; u < 6; u++) {
      const y = 5 + u * 4;
      p.rect(1, y, 12, 3, '#343c4c');
      p.rect(2, y + 1, 1, 1, '#0f131a').rect(4, y + 1, 1, 1, '#0f131a');
      if (v === 2 && u >= 3) {
        p.rect(6, y, 3, 3, '#454f63').rect(10, y, 2, 3, '#454f63');
      } else {
        p.rect(7, y + 1, 5, 1, '#1b2029');
      }
    }
    if (v === 1) p.rect(1, 4, 12, 1, '#4f8fd0');
    p.rect(0, 29, 14, 1, '#161a22');
  });
}

function terminalSprite(): HTMLCanvasElement {
  return makeSprite(30, 26, (p) => {
    p.rect(0, 12, 30, 8, '#aab3c2').rect(0, 12, 30, 1, '#c8cfda');
    p.rect(0, 20, 30, 5, '#7d8798').rect(0, 25, 2, 1, '#59647a').rect(28, 25, 2, 1, '#59647a');
    // CRT
    p.rect(2, 0, 13, 13, '#d8cfb8').rect(2, 0, 13, 1, '#ece5d2').rect(14, 1, 1, 12, '#bdb399');
    p.rect(4, 2, 9, 7, '#0b1a12');
    p.rect(5, 3, 4, 1, '#4be07a').rect(5, 5, 6, 1, '#4be07a').rect(5, 7, 2, 1, '#4be07a');
    p.rect(4, 10, 3, 1, '#9a9078').px(12, 10, '#e0605a');
    p.rect(3, 15, 11, 3, '#cfc7b0').rect(3, 15, 11, 1, '#e6dfcb');
    p.px(4, 16, '#8f866f').px(6, 16, '#8f866f').px(8, 16, '#8f866f').px(10, 16, '#8f866f').px(12, 16, '#8f866f');
    // unidade de fita / impressora
    p.rect(17, 4, 11, 9, '#59647a').rect(17, 4, 11, 1, '#7886a0');
    p.ellipse(20, 8.5, 2, 2, '#232936').ellipse(25, 8.5, 2, 2, '#232936');
    p.px(20, 8, '#8a93a3').px(25, 9, '#8a93a3');
    p.rect(19, 14, 8, 4, C.paper).rect(20, 15, 5, 1, '#b8b2a2').rect(20, 17, 4, 1, '#b8b2a2');
  });
}

function bookshelfSprite(v: number): HTMLCanvasElement {
  const r = rng(9173 + v * 131);
  return makeSprite(14, 30, (p) => {
    p.rect(0, 0, 14, 30, C.wood2).rect(0, 0, 14, 3, C.wood2Hi).rect(0, 0, 14, 1, '#c08a5a');
    p.rect(13, 3, 1, 27, C.wood2Lo);
    for (let s = 0; s < 3; s++) {
      const y = 4 + s * 8;
      p.rect(1, y, 12, 7, '#3d2719');
      let x = 1;
      while (x < 13) {
        const bw = r() < 0.35 ? 1 : 2;
        if (r() < 0.12) {
          x += 1;
          continue;
        }
        const bh = 4 + Math.floor(r() * 3);
        const color = BOOKS[Math.floor(r() * BOOKS.length)]!;
        const w = Math.min(bw, 13 - x);
        p.rect(x, y + 7 - bh, w, bh, color);
        p.rect(x, y + 7 - bh, w, 1, shade(color, 0.3));
        if (w === 2 && r() < 0.5) p.px(x, y + 5, shade(color, -0.3));
        x += w;
      }
      p.rect(1, y + 7, 12, 1, C.wood2Hi);
    }
    p.rect(0, 28, 14, 2, C.wood2Lo);
  });
}

function cabinetSprite(v: number): HTMLCanvasElement {
  const body = v < 2 ? '#8f9aa0' : '#b9a57f';
  return makeSprite(14, 28, (p) => {
    p.rect(0, 0, 14, 28, body).rect(0, 0, 14, 3, shade(body, 0.25)).rect(0, 0, 14, 1, shade(body, 0.45));
    p.rect(13, 3, 1, 25, shade(body, -0.25));
    for (let dI = 0; dI < 3; dI++) {
      const y = 4 + dI * 8;
      const open = v % 2 === 1 && dI === 1;
      p.rect(1, y, 12, 7, shade(body, open ? -0.35 : -0.1));
      if (open) {
        p.rect(2, y, 10, 3, C.paper);
        p.px(3, y, '#e3b23c').px(6, y, '#c8553d').px(9, y, '#3f7fbf');
        p.rect(1, y + 4, 12, 3, shade(body, 0.05)).rect(5, y + 5, 4, 1, shade(body, -0.45));
      } else {
        p.rect(4, y + 1, 6, 2, C.paper).rect(5, y + 4, 4, 1, shade(body, -0.45));
      }
    }
    p.rect(0, 27, 14, 1, shade(body, -0.4));
  });
}

function plantSprite(v: number): HTMLCanvasElement {
  return makeSprite(14, 28, (p) => {
    p.rect(4, 21, 6, 7, C.pot).rect(3, 20, 8, 2, C.potHi).rect(4, 21, 6, 1, '#4a3020');
    p.rect(9, 22, 1, 6, shade(C.pot, -0.2));
    if (v === 0) {
      p.ellipse(6.5, 12, 6.5, 8, C.green);
      p.ellipse(4.5, 9, 3, 3.5, C.greenHi).ellipse(9.5, 14, 3, 3, C.greenLo).ellipse(8, 6, 2.5, 2.5, C.greenHi);
      p.px(3, 14, C.greenLo).px(6, 17, C.greenLo).px(10, 9, C.greenLo);
    } else if (v === 1) {
      const tips: [number, number][] = [[1, 5], [6, 1], [12, 4], [3, 11], [11, 11]];
      for (const [tx, ty] of tips) {
        p.line(7, 20, tx, ty + 2, C.greenLo);
        p.ellipse(tx, ty + 1, 2.4, 2.6, C.green);
        p.px(tx, ty, C.greenHi).px(tx - 1, ty + 1, C.greenHi);
      }
    } else {
      p.rect(3, 7, 2, 14, C.green).rect(3, 7, 1, 14, C.greenHi).px(3, 6, C.green);
      p.rect(6, 3, 2, 18, C.green).rect(6, 3, 1, 18, C.greenHi).px(7, 2, C.green);
      p.rect(9, 9, 2, 12, C.greenLo).rect(9, 9, 1, 12, C.green).px(10, 8, C.greenLo);
      p.px(4, 11, '#d9e08a').px(7, 8, '#d9e08a').px(7, 14, '#d9e08a').px(10, 13, '#d9e08a');
    }
  });
}

function tableReadSprite(): HTMLCanvasElement {
  return makeSprite(64, 18, (p) => {
    p.rect(0, 0, 64, 13, '#b07a4a').rect(0, 0, 64, 1, '#cb945c');
    for (let x = 4; x < 60; x += 11) p.rect(x, 4 + (x % 5), 6, 1, '#a06c3f');
    p.rect(0, 13, 64, 4, '#8f5f38').rect(0, 13, 64, 1, '#a06c3f').rect(0, 17, 64, 1, C.wood2Lo);
    p.rect(1, 14, 2, 4, C.wood2Lo).rect(61, 14, 2, 4, C.wood2Lo);
    // livros abertos e luminária
    for (const x of [6, 40]) {
      p.rect(x, 3, 9, 6, C.paper).rect(x + 4, 3, 1, 6, '#b8b2a2');
      p.rect(x + 1, 5, 2, 1, '#b8b2a2').rect(x + 6, 5, 2, 1, '#b8b2a2').rect(x + 1, 7, 2, 1, '#b8b2a2');
    }
    p.rect(29, 7, 5, 1, '#59647a').rect(31, 4, 1, 3, '#c9a24a');
    p.rect(27, 1, 9, 3, '#3f9d69').rect(27, 1, 9, 1, '#6fc48f');
    p.rect(52, 5, 8, 2, BOOKS[0]!).rect(53, 3, 7, 2, BOOKS[3]!).rect(52, 7, 8, 2, BOOKS[1]!);
    p.rect(20, 6, 3, 3, '#f4f1e8').px(21, 7, '#7a4a2e');
  });
}

function tableMeetSprite(): HTMLCanvasElement {
  return makeSprite(80, 34, (p) => {
    p.rect(0, 0, 80, 28, '#d9c7a8').rect(0, 0, 80, 1, '#ecdfc6');
    p.frame(2, 2, 76, 24, '#c4ae88');
    p.rect(0, 28, 80, 5, '#a38a66').rect(0, 28, 80, 1, '#b99f78').rect(0, 33, 80, 1, '#7d684a');
    p.rect(2, 29, 3, 5, '#7d684a').rect(75, 29, 3, 5, '#7d684a');
    // telefone de conferência
    p.ellipse(39.5, 13.5, 4, 3, '#2c313c');
    p.px(38, 13, '#6fe3a0').px(41, 14, '#59647a');
    // laptops do lado de cima (vistos por trás)
    for (const i of [1, 3]) {
      const x = i * 16 + 3;
      p.rect(x, 3, 10, 6, C.metal).rect(x, 3, 10, 1, C.metalHi).rect(x + 4, 5, 2, 2, '#dfe3ea');
      p.rect(x, 9, 10, 1, C.metalLo);
    }
    // laptops do lado de baixo (tela para a câmera)
    for (const i of [0, 2, 4]) {
      const x = i * 16 + 3;
      p.rect(x, 17, 10, 6, C.dark).rect(x + 1, 18, 8, 4, i === 2 ? '#2a4a6a' : '#1f3554');
      p.rect(x + 2, 19, 4, 1, '#7fb2ff').rect(x + 2, 21, 5, 1, '#6fe3a0');
      p.rect(x, 23, 10, 2, C.metalHi).rect(x, 25, 10, 1, C.metal);
    }
    // papéis e xícaras
    p.rect(22, 16, 6, 7, C.paper).rect(23, 18, 4, 1, '#b8b2a2').rect(23, 20, 3, 1, '#b8b2a2');
    p.rect(55, 4, 6, 7, C.paper).rect(56, 6, 4, 1, '#b8b2a2');
    p.rect(8, 6, 3, 3, '#f4f1e8').px(9, 7, '#7a4a2e');
    p.rect(68, 19, 3, 3, '#f4f1e8').px(69, 20, '#7a4a2e');
    p.rect(44, 11, 2, 5, '#e0605a').rect(47, 12, 2, 4, '#3f7fbf');
  });
}

function counterSprite(): HTMLCanvasElement {
  return makeSprite(80, 32, (p) => {
    // azulejos
    p.rect(0, 2, 80, 11, '#d5e6e4');
    for (let x = 0; x < 80; x += 5) p.rect(x, 2, 1, 11, '#b9d0cd');
    p.rect(0, 7, 80, 1, '#b9d0cd').rect(0, 2, 80, 1, '#eef6f5');
    // tampo e armários
    p.rect(0, 13, 80, 5, '#5a6272').rect(0, 13, 80, 1, '#808a9c');
    p.rect(0, 18, 80, 13, '#ded8c8').rect(0, 31, 80, 1, '#6f6a5e');
    for (let k = 0; k < 5; k++) {
      p.rect(k * 16, 19, 1, 12, '#bdb5a0');
      p.rect(k * 16 + 7, 21, 3, 1, '#8a8272');
    }
    p.rect(79, 19, 1, 12, '#bdb5a0');
    // potes
    p.rect(3, 7, 5, 6, '#e3b23c').rect(3, 6, 5, 1, '#8a6a2a').rect(4, 8, 1, 3, '#f2cf6a');
    p.rect(10, 9, 4, 4, '#f4f1e8').rect(10, 9, 4, 1, '#ffffff');
    // máquina de café
    p.rect(18, 0, 12, 13, '#b8433a').rect(18, 0, 12, 2, '#d76055').rect(29, 2, 1, 11, '#96342d');
    p.rect(20, 3, 8, 3, C.dark).px(26, 4, '#6fe3a0').px(21, 4, '#e3b23c');
    p.rect(23, 7, 2, 2, C.dark);
    p.rect(22, 9, 4, 3, '#f4f1e8').px(26, 10, '#f4f1e8');
    p.rect(19, 12, 10, 1, '#3a3f4d');
    // pia
    p.rect(41, 13, 14, 4, '#aab3c2').rect(42, 14, 12, 2, '#6f7b8f');
    p.rect(47, 7, 2, 6, '#c9ccd6').rect(47, 7, 5, 2, '#c9ccd6').px(51, 9, '#c9ccd6');
    // micro-ondas
    p.rect(62, 3, 15, 10, '#3a3f4d').rect(62, 3, 15, 1, '#555c6c');
    p.rect(63, 5, 9, 7, '#161b26').px(65, 6, '#2c3546').px(66, 7, '#2c3546');
    p.px(74, 5, '#6fe3a0').px(74, 7, '#8a93a3').px(74, 9, '#8a93a3').px(75, 11, '#8a93a3');
  });
}

function fridgeSprite(): HTMLCanvasElement {
  return makeSprite(14, 30, (p) => {
    p.rect(0, 0, 14, 30, '#e6ebef').rect(0, 0, 14, 3, '#f6f9fb').rect(13, 3, 1, 27, '#b9c2cb');
    p.rect(0, 12, 14, 1, '#aab3bd');
    p.rect(11, 6, 1, 4, C.metal).rect(11, 15, 1, 7, C.metal);
    p.rect(3, 6, 2, 2, '#e0605a').rect(6, 8, 2, 2, '#e3b23c').rect(4, 16, 3, 3, '#7fb2ff').px(8, 18, '#4f9d69');
    p.rect(0, 29, 14, 1, '#7d8798');
  });
}

function coolerSprite(): HTMLCanvasElement {
  return makeSprite(12, 26, (p) => {
    p.rect(2, 0, 8, 9, '#6fc3f5').rect(2, 0, 8, 1, '#b8e6ff').rect(3, 2, 1, 5, '#b8e6ff').rect(9, 1, 1, 8, '#4f9fd0');
    p.rect(4, 9, 4, 2, '#4f9fd0');
    p.rect(1, 11, 10, 15, '#eef1f4').rect(1, 11, 10, 1, '#ffffff').rect(10, 12, 1, 14, '#b9c2cb');
    p.px(4, 14, '#e0605a').px(7, 14, '#4f9fd0');
    p.rect(3, 17, 6, 1, '#8a93a3').rect(3, 20, 6, 4, '#d5dbe2');
  });
}

function vendingSprite(): HTMLCanvasElement {
  return makeSprite(14, 30, (p) => {
    p.rect(0, 0, 14, 30, '#2f4a7a').rect(0, 0, 14, 3, '#4a6aa3').rect(13, 3, 1, 27, '#223760');
    p.rect(1, 4, 9, 17, '#0f1826');
    const cols = ['#e0605a', '#e3b23c', '#6fe3a0', '#7fb2ff', '#ff8fb1'];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 3; c++) p.rect(2 + c * 3, 5 + r * 4, 2, 3, cols[(r * 2 + c) % cols.length]!);
      p.rect(1, 8 + r * 4, 9, 1, '#2a3550');
    }
    p.rect(11, 6, 2, 8, '#17233f').px(11, 7, '#6fe3a0').px(12, 10, '#e3b23c');
    p.rect(2, 23, 8, 4, '#0b1220').rect(2, 23, 8, 1, '#3a4a70');
    p.rect(0, 29, 14, 1, '#16223c');
  });
}

function tableCopaSprite(): HTMLCanvasElement {
  return makeSprite(32, 34, (p) => {
    p.rect(14, 22, 4, 9, C.metal).rect(14, 22, 1, 9, C.metalHi);
    p.ellipse(15.5, 31.5, 7, 2, C.metalLo);
    p.ellipse(15.5, 14, 15.5, 12, '#c9c0aa');
    p.ellipse(15.5, 12, 15.5, 12, '#f3efe3');
    p.ellipse(15.5, 11, 12, 8.5, '#fbf8f0');
    // xícaras, prato e açucareiro
    p.rect(6, 9, 4, 3, '#e0605a').px(10, 10, '#e0605a').rect(7, 10, 2, 1, '#5a3220');
    p.rect(21, 14, 4, 3, '#4f9fd0').px(25, 15, '#4f9fd0').rect(22, 15, 2, 1, '#5a3220');
    p.ellipse(15.5, 8, 4, 2.4, '#e2dccb');
    p.rect(13, 7, 2, 2, '#c98a4a').rect(16, 7, 2, 2, '#b5753a').px(15, 9, '#c98a4a');
    p.rect(12, 15, 3, 4, '#f4f1e8').rect(12, 15, 3, 1, '#8a93a3');
  });
}

function sofaSprite(): HTMLCanvasElement {
  return makeSprite(64, 24, (p) => {
    p.rect(2, 0, 60, 10, '#3d8a85').rect(2, 0, 60, 2, '#5bb0a9');
    p.rect(0, 3, 4, 20, '#34787a').rect(60, 3, 4, 20, '#34787a').rect(0, 3, 4, 2, '#4c9e98').rect(60, 3, 4, 2, '#4c9e98');
    p.rect(4, 10, 56, 10, '#49a39c').rect(4, 10, 56, 1, '#63bdb5');
    for (const x of [18, 32, 46]) p.rect(x, 2, 1, 18, '#34787a');
    p.rect(4, 20, 56, 3, '#34787a');
    p.rect(2, 23, 3, 1, '#2a2f3a').rect(59, 23, 3, 1, '#2a2f3a');
    p.rect(6, 5, 7, 6, '#f0c35a').rect(6, 5, 7, 1, '#ffe08f').rect(12, 6, 1, 5, '#cf9f3c');
    p.rect(50, 5, 7, 6, '#e98a6a').rect(50, 5, 7, 1, '#ffb295');
  });
}

function coffeeTableSprite(): HTMLCanvasElement {
  return makeSprite(30, 12, (p) => {
    p.rect(0, 0, 30, 8, '#9a6a40').rect(0, 0, 30, 1, '#b98557');
    p.rect(0, 8, 30, 3, '#7a5230').rect(1, 11, 2, 1, C.wood2Lo).rect(27, 11, 2, 1, C.wood2Lo);
    p.rect(4, 2, 8, 4, '#d9d3c3').rect(4, 2, 8, 1, '#e0605a').rect(6, 4, 4, 1, '#8a8272');
    p.rect(20, 2, 3, 3, '#f4f1e8').px(21, 3, '#5a3220');
  });
}

function puffSprite(v: number): HTMLCanvasElement {
  const col = v === 0 ? '#d46a6a' : '#8e7ad6';
  return makeSprite(14, 12, (p) => {
    p.ellipse(6.5, 7, 7, 5, shade(col, -0.2));
    p.ellipse(6.5, 6, 6.5, 4.6, col);
    p.ellipse(5, 4.5, 3, 1.8, shade(col, 0.25));
    p.rect(5, 7, 4, 1, shade(col, -0.2));
  });
}

function consoleSprite(): HTMLCanvasElement {
  return makeSprite(46, 24, (p) => {
    p.rect(0, 8, 46, 8, '#3d4a66').rect(0, 8, 46, 1, '#5a6b90');
    p.rect(0, 16, 46, 7, '#2c3650').rect(0, 16, 46, 1, '#5fe0e8').rect(0, 23, 46, 1, '#1d2438');
    p.rect(1, 18, 2, 5, '#1d2438').rect(43, 18, 2, 5, '#1d2438');
    for (let x = 6; x < 42; x += 6) p.px(x, 19, '#5fe0e8');
    // monitores laterais
    p.rect(2, 0, 12, 9, '#1c2230').rect(3, 1, 10, 6, '#0f2a3a');
    p.line(3, 5, 6, 2, '#5fe0e8').line(6, 2, 9, 5, '#5fe0e8').line(9, 5, 12, 3, '#5fe0e8');
    p.rect(32, 0, 12, 9, '#1c2230').rect(33, 1, 10, 6, '#0f2a3a');
    p.px(35, 3, '#6fe3a0').px(38, 2, '#6fe3a0').px(40, 5, '#6fe3a0').px(36, 5, '#ffd166').px(41, 3, '#ff8fb1');
    p.rect(4, 11, 8, 2, '#8a93a3').rect(34, 11, 8, 2, '#8a93a3');
    // projetor do globo
    p.rect(18, 9, 10, 4, '#6f7d99').rect(18, 9, 10, 1, '#93a3c2');
    p.rect(20, 7, 6, 2, '#2a3350').rect(21, 6, 4, 1, '#8fe8ff');
  });
}

function globeSprites(): HTMLCanvasElement[] {
  const land = [
    ['..XX....', '.XXXX...', '.XXX....', '..X..XX.', '....XXX.', '.....X..'],
    ['....XX..', '...XXXX.', '...XXX..', 'X...X...', 'XX......', 'X.......'],
    ['......XX', '.....XXX', 'X....XX.', 'XX......', 'XXX.....', '.X......'],
    ['X.......', 'XX......', 'XX.X....', '..XXX...', '..XXXX..', '...XX...'],
  ];
  return land.map((rows) =>
    makeSprite(
      12,
      12,
      (p) => {
        p.ellipse(5.5, 5.5, 6, 6, '#2f7fc8');
        p.ellipse(4.5, 4.5, 4, 4, '#4f9fe0');
        p.bitmap(2, 3, rows, { X: '#6fd08a' });
        p.px(3, 2, '#b8e6ff').px(4, 1, '#b8e6ff');
        p.rect(0, 5, 12, 1, 'rgba(143,232,255,0.55)');
      },
      '#1b3f6e',
    ),
  );
}

function towerSprite(): HTMLCanvasElement {
  return makeSprite(14, 46, (p) => {
    p.line(2, 44, 6, 6, '#9aa3b2').line(11, 44, 7, 6, '#9aa3b2');
    for (let y = 40, i = 0; y > 8; y -= 6, i++) {
      const t = (44 - y) / 38;
      const l = Math.round(2 + 4 * t);
      const r = Math.round(11 - 4 * t);
      p.line(l, y, r, y, '#7d8798');
      const l2 = Math.round(2 + 4 * ((44 - (y - 6)) / 38));
      const r2 = Math.round(11 - 4 * ((44 - (y - 6)) / 38));
      if (y - 6 > 6) {
        if (i % 2 === 0) p.line(l, y, r2, y - 6, '#6a7486');
        else p.line(r, y, l2, y - 6, '#6a7486');
      }
    }
    p.rect(6, 1, 2, 6, '#c9ccd6');
    p.rect(8, 15, 4, 3, '#eef1f4').px(9, 16, '#b9c2cb');
    p.rect(1, 24, 3, 3, '#eef1f4').px(2, 25, '#b9c2cb');
    p.rect(1, 44, 12, 2, '#59647a').rect(1, 44, 12, 1, '#7886a0');
  });
}

function dishSprite(): HTMLCanvasElement {
  return makeSprite(18, 30, (p) => {
    p.rect(8, 14, 2, 14, C.metal).rect(8, 14, 1, 14, C.metalHi);
    p.rect(4, 27, 10, 2, '#59647a').rect(4, 27, 10, 1, '#7886a0');
    p.line(5, 27, 8, 21, C.metalLo).line(12, 27, 9, 21, C.metalLo);
    p.ellipse(7.5, 9, 7.5, 7, '#d5dbe2');
    p.ellipse(8, 8.5, 6.4, 6, '#f2f5f8');
    p.ellipse(9, 9.5, 4.4, 4, '#c3ccd8');
    p.ellipse(9.5, 10, 2.4, 2.2, '#aab5c4');
    p.line(9, 10, 14, 3, '#59647a');
    p.rect(13, 1, 3, 3, '#e0605a').px(14, 2, '#ffb0a8');
  });
}

function waveSprites(): HTMLCanvasElement[] {
  return [0, 1, 2].map((f) =>
    makeFlat(12, 12, (p) => {
      const col = rgba('#8fe8ff', 0.9 - f * 0.25);
      const r = 3 + f * 3;
      for (let a = -80; a <= -10; a += 6) {
        const rad = (a * Math.PI) / 180;
        p.px(Math.round(Math.cos(rad) * r), 11 + Math.round(Math.sin(rad) * r), col);
      }
    }),
  );
}

function benchSprite(): HTMLCanvasElement {
  return makeSprite(96, 18, (p) => {
    p.rect(0, 0, 96, 12, '#c9a070').rect(0, 0, 96, 1, '#dfb888');
    for (let x = 7; x < 92; x += 13) p.rect(x, 9 + (x % 2), 5, 1, '#b98f60');
    p.rect(0, 12, 96, 5, '#9a7448').rect(0, 12, 96, 1, '#b08656').rect(0, 17, 96, 1, '#74552f');
    for (const x of [0, 47, 94]) p.rect(x, 13, 2, 5, '#74552f');
    for (let i = 0; i < 6; i++) {
      const x = i * 16 + 3;
      p.rect(x, 1, 10, 6, C.metal).rect(x, 1, 10, 1, C.metalHi).rect(x + 4, 3, 2, 2, '#e6eaf0');
      p.rect(x, 7, 10, 2, '#6f7888');
    }
  });
}

function arcadeSprites(): HTMLCanvasElement[] {
  return [0, 1].map((f) =>
    makeSprite(14, 30, (p) => {
      p.rect(0, 0, 14, 30, '#5a3d8a').rect(0, 0, 14, 1, '#7a5ab0').rect(13, 1, 1, 29, '#432c6b');
      p.rect(1, 1, 12, 4, '#ffd166').rect(3, 2, 2, 2, '#e0605a').rect(6, 2, 2, 2, '#3f7fbf').rect(9, 2, 2, 2, '#4f9d69');
      p.rect(2, 7, 10, 8, '#0b1220');
      const inv = f === 0 ? ['.X..X.', 'XXXXXX', 'X.XX.X'] : ['X.XX.X', 'XXXXXX', '.X..X.'];
      p.bitmap(4, 8, inv, { X: '#6fe3a0' });
      p.px(f === 0 ? 5 : 8, 13, '#ffd166');
      p.rect(1, 16, 12, 3, '#3a2a5c').px(4, 16, '#e0605a').px(4, 17, '#c9ccd6').px(8, 17, '#ffd166').px(10, 17, '#6fe3ff');
      p.rect(1, 20, 12, 1, '#ff8fb1').rect(1, 22, 12, 1, '#6fe3ff');
      p.rect(5, 24, 4, 3, '#2a1c47').px(6, 25, '#ffd166');
      p.rect(0, 29, 14, 1, '#2a1c47');
    }),
  );
}

function copierSprite(): HTMLCanvasElement {
  return makeSprite(14, 24, (p) => {
    p.rect(0, 0, 14, 24, '#dfe3e8').rect(0, 0, 14, 4, '#c3c9d2').rect(0, 0, 14, 1, '#f1f4f7');
    p.rect(13, 4, 1, 20, '#aab3bd');
    p.rect(1, 5, 5, 3, '#2c313c').px(2, 6, '#6fe3a0').px(4, 6, '#e3b23c');
    p.rect(2, 11, 10, 2, '#f8f8f4').rect(2, 13, 10, 1, '#8a93a3');
    p.rect(1, 15, 12, 1, '#aab3bd').rect(1, 19, 12, 1, '#aab3bd').rect(6, 17, 2, 1, '#8a93a3').rect(6, 21, 2, 1, '#8a93a3');
    p.rect(0, 23, 14, 1, '#7d8798');
  });
}

function floorLampSprite(): HTMLCanvasElement {
  return makeSprite(12, 34, (p) => {
    p.rect(5, 7, 2, 25, '#6f7888').rect(5, 7, 1, 25, '#9aa3b2');
    p.rect(2, 31, 8, 2, '#59647a').rect(2, 31, 8, 1, '#7886a0');
    p.rect(2, 0, 8, 2, '#f7dc94').rect(1, 2, 10, 5, '#f0c56a').rect(1, 6, 10, 1, '#cf9f3c').rect(1, 2, 1, 4, '#fbe7ae');
  });
}

// ─────────────────────────────── decoração de parede ───────────────────────────────

function whiteboardSprites(): HTMLCanvasElement[] {
  return [0, 1, 2, 3].map((f) =>
    makeSprite(62, 24, (p) => {
      p.rect(0, 0, 62, 22, '#9aa3b2').rect(0, 0, 62, 1, '#c3cad6');
      p.rect(1, 1, 60, 19, '#f8f8f4').rect(1, 1, 60, 1, '#ffffff');
      p.rect(3, 21, 56, 2, '#7d8798').rect(3, 21, 56, 1, '#aab3c2');
      p.rect(8, 21, 4, 1, '#e0605a').rect(14, 21, 4, 1, '#3f7fbf').rect(20, 21, 4, 1, '#4f9d69').rect(48, 21, 5, 1, '#3a3f4d');
      p.px(52, 4, '#e2e2dc').px(40, 15, '#e2e2dc').px(10, 16, '#e2e2dc');
      if (f >= 1) {
        p.frame(4, 4, 12, 7, '#3f7fbf').frame(22, 4, 12, 7, '#e0605a');
        p.rect(16, 7, 6, 1, '#3a3f4d').px(20, 6, '#3a3f4d').px(20, 8, '#3a3f4d');
        p.rect(6, 6, 6, 1, '#8a93a3').rect(6, 8, 4, 1, '#8a93a3').rect(24, 6, 7, 1, '#8a93a3');
      }
      if (f >= 2) {
        p.rect(42, 3, 5, 5, '#ffd166').rect(48, 3, 5, 5, '#ff8fb1').rect(54, 3, 5, 5, '#8fe0a8');
        p.rect(42, 9, 5, 5, '#8fc8ff').rect(48, 9, 5, 5, '#ffd166');
        p.rect(28, 11, 1, 4, '#3a3f4d').frame(22, 14, 12, 5, '#4f9d69');
      }
      if (f >= 3) {
        p.rect(4, 14, 2, 2, '#4f9d69').rect(7, 15, 8, 1, '#3a3f4d');
        p.rect(4, 17, 2, 2, '#4f9d69').rect(7, 18, 6, 1, '#3a3f4d');
        p.rect(54, 9, 5, 5, '#c9a6ff').ring(45, 16, 4, 2, '#e0605a');
      }
    }),
  );
}

function doorSprites(): HTMLCanvasElement[] {
  return [0, 1, 2].map((f) =>
    makeFlat(32, 32, (p) => {
      p.rect(0, 0, 32, 32, '#4a3d33').rect(0, 0, 32, 1, '#6a594b').rect(0, 0, 1, 32, '#6a594b');
      p.rect(2, 2, 28, 30, '#161821').rect(2, 24, 28, 8, '#232733').rect(2, 28, 28, 4, '#2f3443');
      // folhas de vidro: 0 = fechada, 1 = meio aberta, 2 = aberta
      const lw = f === 0 ? 14 : f === 1 ? 8 : 3;
      const glass = '#9cc3d8';
      for (const left of [true, false]) {
        const x = left ? 2 : 30 - lw;
        p.rect(x, 2, lw, 30, glass).rect(x, 28, lw, 4, '#7d8798').rect(x, 2, lw, 1, '#c6e2f0');
        if (lw >= 8) {
          p.line(x + 2, 12, x + 6, 5, '#c6e2f0').line(x + 3, 16, x + lw - 3, 6, '#c6e2f0');
        }
        p.rect(left ? x + lw - 1 : x, 2, 1, 30, '#5d7f93');
        if (lw >= 8) p.rect(left ? x + lw - 3 : x + 2, 16, 1, 5, '#eef3f6');
      }
    }),
  );
}

function windowSprite(): HTMLCanvasElement {
  return makeSprite(30, 22, (p) => {
    p.rect(0, 0, 30, 21, '#f3efe4').rect(0, 0, 30, 1, '#ffffff');
    p.clear(2, 2, 12, 17).clear(16, 2, 12, 17);
    p.rect(2, 10, 12, 1, '#f3efe4').rect(16, 10, 12, 1, '#f3efe4');
    p.rect(-1, 21, 32, 1, '#d2cab6');
  });
}

function clockSprite(): HTMLCanvasElement {
  return makeSprite(14, 14, (p) => {
    p.ellipse(6.5, 6.5, 7, 7, '#3a3f4d');
    p.ellipse(6.5, 6.5, 6, 6, '#f8f4e8');
    p.px(6, 1, '#8a8272').px(7, 1, '#8a8272').px(6, 12, '#8a8272').px(7, 12, '#8a8272');
    p.px(1, 6, '#8a8272').px(1, 7, '#8a8272').px(12, 6, '#8a8272').px(12, 7, '#8a8272');
  });
}

function posterSprite(): HTMLCanvasElement {
  return makeSprite(30, 18, (p) => {
    p.rect(0, 0, 30, 18, C.wood2).rect(1, 1, 28, 16, '#c99a66');
    const r = rng(77);
    for (let i = 0; i < 26; i++) p.px(1 + Math.floor(r() * 28), 1 + Math.floor(r() * 16), '#b98a58');
    p.rect(3, 3, 7, 6, C.paper).rect(4, 5, 5, 1, '#b8b2a2').rect(4, 7, 3, 1, '#b8b2a2').px(6, 3, '#e0605a');
    p.rect(12, 2, 6, 6, '#ffd166').px(14, 2, '#3f7fbf').rect(13, 4, 4, 1, '#b08a2a');
    p.rect(20, 4, 7, 8, '#8fc8ff').px(23, 4, '#e0605a').rect(21, 7, 5, 1, '#4f7fb0').rect(21, 9, 3, 1, '#4f7fb0');
    p.rect(4, 11, 6, 5, '#ff8fb1').px(6, 11, '#4f9d69');
    p.rect(12, 10, 6, 6, C.paper).rect(13, 12, 4, 1, '#b8b2a2').px(15, 10, '#e3b23c');
  });
}

function tvSprites(): HTMLCanvasElement[] {
  return [0, 1, 2].map((f) =>
    makeSprite(46, 22, (p) => {
      p.rect(0, 0, 46, 22, '#1c2230').rect(1, 1, 44, 19, '#0f2238');
      p.px(43, 20, '#6fe3a0');
      const heights = [
        [5, 9, 7, 12, 10],
        [7, 6, 10, 9, 13],
        [4, 10, 8, 13, 11],
      ][f]!;
      const cols = ['#7fb2ff', '#6fe3a0', '#ffd166', '#ff8fb1', '#b79cff'];
      heights.forEach((hh, i) => p.rect(4 + i * 5, 18 - hh, 3, hh, cols[i]!));
      p.rect(3, 18, 26, 1, '#3a4a66');
      const pts = [
        [31, 13, 34, 9, 37, 11, 40, 5, 43, 7],
        [31, 11, 34, 12, 37, 7, 40, 8, 43, 4],
        [31, 14, 34, 10, 37, 9, 40, 6, 43, 5],
      ][f]!;
      for (let i = 0; i < 4; i++) p.line(pts[i * 2]!, pts[i * 2 + 1]!, pts[i * 2 + 2]!, pts[i * 2 + 3]!, '#ffd166');
      p.rect(31, 16, 12, 1, '#3a4a66').rect(4, 3, 10, 1, '#5f7aa0').rect(31, 2, 8, 1, '#5f7aa0');
    }),
  );
}

function acSprite(): HTMLCanvasElement {
  return makeSprite(30, 10, (p) => {
    p.rect(0, 0, 30, 10, '#e8ecef').rect(0, 0, 30, 1, '#ffffff').rect(0, 9, 30, 1, '#aab3bd');
    p.rect(2, 5, 26, 1, '#b8c0cc').rect(2, 7, 26, 1, '#b8c0cc');
    p.px(26, 2, '#6fe3a0').rect(3, 2, 6, 1, '#b8c0cc');
  });
}

// ─────────────────────────────── efeitos ───────────────────────────────

function fanSprites(): HTMLCanvasElement[] {
  const out: HTMLCanvasElement[] = [];
  for (let f = 0; f < 6; f++) {
    out.push(
      makeSprite(
        46,
        46,
        (p) => {
          const c = 22.5;
          for (let b = 0; b < 4; b++) {
            const a = ((f * 15 + b * 90) * Math.PI) / 180;
            const dx = Math.cos(a);
            const dy = Math.sin(a);
            for (let off = -1.5; off <= 1.5; off++) {
              const ox = -dy * off;
              const oy = dx * off;
              const col = off < -1 ? '#cfd3da' : off > 1 ? '#ffffff' : '#eef0f4';
              p.line(c + dx * 4 + ox, c + dy * 4 + oy, c + dx * 18 + ox, c + dy * 18 + oy, col);
            }
          }
          p.ellipse(c, c, 3.5, 3.5, '#6f7b90');
          p.ellipse(c, c, 1.5, 1.5, '#aab3c2');
        },
        '#7d8494',
      ),
    );
  }
  return out;
}

function ringSprites(): HTMLCanvasElement[] {
  const out: HTMLCanvasElement[] = [];
  for (let k = 0; k < 6; k++) {
    out.push(
      makeFlat(36, 20, (p) => {
        const rx = 6 + k * 2;
        const ry = 2.6 + k * 1.1;
        p.ring(17.5, 9.5, rx, ry, '#ffffff');
        if (k < 3) p.ring(17.5, 9.5, rx - 1, ry - 0.6, '#ffffff');
      }),
    );
  }
  return out;
}

function glowSprite(): HTMLCanvasElement {
  return makeFlat(64, 64, (p) => {
    // Muitos degraus de baixa opacidade: borda suave, sem faixas marcadas.
    for (let r = 31; r >= 3; r -= 2) p.ellipse(31.5, 31.5, r, r, 'rgba(255,255,255,0.036)');
  });
}

function beamSprite(): HTMLCanvasElement {
  return makeFlat(40, 44, (p) => {
    for (let y = 0; y < 44; y++) {
      const t = y / 44;
      const alpha = 0.3 * (1 - t);
      const x0 = Math.round(6 - t * 6);
      const x1 = Math.round(34 + t * 6);
      p.rect(x0, y, x1 - x0, 1, `rgba(255,255,255,${alpha.toFixed(3)})`);
    }
  });
}

/** Área de céu visível em cada janela. */
export const SKY_W = 26;
export const SKY_H = 17;

function starsSprite(): HTMLCanvasElement {
  return makeFlat(SKY_W, SKY_H, (p) => {
    const r = rng(4242);
    for (let i = 0; i < 11; i++) {
      p.px(Math.floor(r() * SKY_W), Math.floor(r() * 13), `rgba(255,255,255,${(0.5 + r() * 0.5).toFixed(2)})`);
    }
    // lua crescente
    p.bitmap(18, 2, ['.XXX.', 'XX...', 'XX...', 'XX...', '.XXX.'], { X: 'rgba(255,246,208,0.95)' });
  });
}

function cloudSprite(): HTMLCanvasElement {
  return makeFlat(96, SKY_H, (p) => {
    const blobs: [number, number, number][] = [
      [10, 5, 7],
      [34, 11, 6],
      [58, 4, 8],
      [82, 12, 6],
    ];
    for (const [x, y, w] of blobs) {
      p.rect(x, y, w, 2, 'rgba(255,255,255,0.85)');
      p.rect(x + 1, y - 1, w - 3, 1, 'rgba(255,255,255,0.85)');
      p.rect(x - 2, y + 1, w + 3, 1, 'rgba(255,255,255,0.7)');
    }
  });
}

function skyGradSprite(): HTMLCanvasElement {
  return makeFlat(2, SKY_H, (p) => {
    for (let y = 0; y < SKY_H; y++) p.rect(0, y, 2, 1, `rgba(255,255,255,${(y / (SKY_H - 1)).toFixed(3)})`);
  });
}

function steamSprites(): HTMLCanvasElement[] {
  const frames = [
    ['.X...', '..X..', '.X...', '..X..', '.....', '.....'],
    ['..X..', '.X...', '..X..', '...X.', '..X..', '.....'],
    ['...X.', '..X..', '.X...', '..X..', '...X.', '..X..'],
  ];
  return frames.map((rows) => makeFlat(5, 6, (p) => p.bitmap(0, 0, rows, { X: 'rgba(255,255,255,0.75)' })));
}

function shadowSprite(): HTMLCanvasElement {
  return makeFlat(16, 7, (p) => {
    p.ellipse(7.5, 3, 7, 3, 'rgba(18,14,28,0.30)');
  });
}

function selectionSprite(): HTMLCanvasElement {
  return makeFlat(28, 14, (p) => {
    p.ring(13.5, 6.5, 12, 5.5, '#ffffff', 6);
    p.ring(13.5, 6.5, 11, 4.9, '#ffffff', 6);
  });
}

// ─────────────────────────────── montagem ───────────────────────────────

interface Spec {
  frame: string;
  /** Deslocamento do conteúdo em relação ao canto do footprint. */
  ax: number;
  /** Deslocamento da base do conteúdo em relação à base do footprint. */
  ay: number;
  /** Ajuste da profundidade (0 = base do footprint). */
  dz: number;
}

function specFor(f: Furniture): Spec | null {
  switch (f.kind) {
    case 'rack':
      return { frame: `rack-${f.variant % 3}`, ax: 1, ay: 0, dz: 0 };
    case 'terminal':
      return { frame: 'terminal', ax: 1, ay: 0, dz: 0 };
    case 'pod':
      return { frame: `pod-${f.variant % 6}`, ax: 0, ay: 0, dz: 0 };
    case 'plant':
      return { frame: `plant-${f.variant % 3}`, ax: 1, ay: -1, dz: 0 };
    case 'bookshelf':
      return { frame: `bookshelf-${f.variant % 4}`, ax: 1, ay: 0, dz: 0 };
    case 'cabinet':
      return { frame: `cabinet-${f.variant % 4}`, ax: 1, ay: 0, dz: 0 };
    case 'tableRead':
      return { frame: 'tableRead', ax: 0, ay: 0, dz: 0 };
    case 'tableMeet':
      return { frame: 'tableMeet', ax: 0, ay: 0, dz: 0 };
    case 'counter':
      return { frame: 'counter', ax: 0, ay: 0, dz: 0 };
    case 'fridge':
      return { frame: 'fridge', ax: 1, ay: 0, dz: 0 };
    case 'cooler':
      return { frame: 'cooler', ax: 2, ay: 0, dz: 0 };
    case 'vending':
      return { frame: 'vending', ax: 1, ay: 0, dz: 0 };
    case 'tableCopa':
      return { frame: 'tableCopa', ax: 0, ay: 0, dz: 0 };
    case 'sofa':
      return { frame: 'sofa', ax: 0, ay: 0, dz: -12 };
    case 'coffeeTable':
      return { frame: 'coffeeTable', ax: 1, ay: -2, dz: 0 };
    case 'puff':
      return { frame: `puff-${f.variant % 2}`, ax: 1, ay: -2, dz: -13 };
    case 'console':
      return { frame: 'console', ax: 1, ay: 0, dz: 0 };
    case 'tower':
      return { frame: 'tower', ax: 1, ay: 0, dz: 0 };
    case 'dish':
      return { frame: 'dish', ax: -1, ay: 0, dz: 0 };
    case 'bench':
      return { frame: 'bench', ax: 0, ay: 0, dz: 0 };
    case 'arcade':
      return { frame: 'arcade-0', ax: 1, ay: 0, dz: 0 };
    case 'copier':
      return { frame: 'copier', ax: 1, ay: 0, dz: 0 };
    case 'lamp':
      return { frame: 'lamp', ax: 2, ay: 0, dz: 0 };
    default:
      return null;
  }
}

export function buildWorldArt(office: OfficeLayout): WorldArt {
  const atlas = new AtlasBuilder(512);
  const addAll = (prefix: string, sprites: HTMLCanvasElement[]): void => {
    sprites.forEach((s, i) => atlas.add(`${prefix}-${i}`, s));
  };

  for (let i = 0; i < 6; i++) atlas.add(`pod-${i}`, podSprite(i * 3 + 1));
  addAll('screen', screenSprites());
  for (let i = 0; i < 3; i++) atlas.add(`rack-${i}`, rackSprite(i));
  atlas.add('terminal', terminalSprite());
  for (let i = 0; i < 4; i++) atlas.add(`bookshelf-${i}`, bookshelfSprite(i));
  for (let i = 0; i < 4; i++) atlas.add(`cabinet-${i}`, cabinetSprite(i));
  for (let i = 0; i < 3; i++) atlas.add(`plant-${i}`, plantSprite(i));
  for (let i = 0; i < 3; i++) atlas.add(`chairback-${i}`, chairBackSprite(i));
  atlas.add('tableRead', tableReadSprite());
  atlas.add('tableMeet', tableMeetSprite());
  atlas.add('counter', counterSprite());
  atlas.add('fridge', fridgeSprite());
  atlas.add('cooler', coolerSprite());
  atlas.add('vending', vendingSprite());
  atlas.add('tableCopa', tableCopaSprite());
  atlas.add('sofa', sofaSprite());
  atlas.add('coffeeTable', coffeeTableSprite());
  for (let i = 0; i < 2; i++) atlas.add(`puff-${i}`, puffSprite(i));
  atlas.add('console', consoleSprite());
  addAll('globe', globeSprites());
  atlas.add('tower', towerSprite());
  atlas.add('dish', dishSprite());
  addAll('wave', waveSprites());
  atlas.add('bench', benchSprite());
  addAll('arcade', arcadeSprites());
  atlas.add('copier', copierSprite());
  atlas.add('lamp', floorLampSprite());
  addAll('whiteboard', whiteboardSprites());
  addAll('door', doorSprites());
  atlas.add('window', windowSprite());
  atlas.add('clock', clockSprite());
  atlas.add('poster', posterSprite());
  addAll('tv', tvSprites());
  atlas.add('ac', acSprite());
  addAll('fan', fanSprites());
  addAll('ring', ringSprites());
  atlas.add('glow', glowSprite());
  atlas.add('beam', beamSprite());
  atlas.add('stars', starsSprite());
  atlas.add('cloud', cloudSprite());
  atlas.add('skygrad', skyGradSprite());
  addAll('steam', steamSprites());
  atlas.add('shadow', shadowSprite());
  atlas.add('selection', selectionSprite());
  atlas.add(
    'white',
    makeFlat(4, 4, (p) => p.rect(0, 0, 4, 4, '#ffffff')),
  );

  const placements: Placement[] = [];
  const wall: Placement[] = [];
  const rackLeds: WorldArt['rackLeds'] = [];
  const steam: Anchor[] = [];
  const lamps: { x: number; y: number }[] = [];
  let globe: Anchor = { x: 0, y: 0, z: 0 };
  let towerLight: Anchor = { x: 0, y: 0, z: 0 };
  let dishWave: Anchor = { x: 0, y: 0, z: 0 };
  let crt: Anchor = { x: 0, y: 0, z: 0 };
  let arcade: Anchor = { x: 0, y: 0, z: 0 };

  for (const f of office.furniture) {
    const bottom = (f.y + f.h) * TILE;
    if (f.kind === 'chair') {
      if (f.dir === 'up') {
        placements.push({
          frame: `chairback-${f.variant % 3}`,
          x: f.x * TILE + 2,
          y: f.y * TILE + 4,
          z: bottom + 0.5,
        });
      }
      continue;
    }
    const spec = specFor(f);
    if (!spec) continue;
    const frame = atlas.frames.get(spec.frame);
    if (!frame) throw new Error(`sprite ausente: ${spec.frame}`);
    const x = f.x * TILE + spec.ax - 1;
    const y = bottom + spec.ay - (frame.h - 1);
    const z = bottom + spec.dz;
    placements.push({ frame: spec.frame, x, y, z });

    if (f.kind === 'rack') {
      for (let u = 0; u < 6; u++) {
        rackLeds.push({ x: x + 3, y: y + 7 + u * 4, z: z + 0.1 });
        rackLeds.push({ x: x + 5, y: y + 7 + u * 4, z: z + 0.1 });
      }
    } else if (f.kind === 'terminal') {
      crt = { x: x + 9, y: y + 8, z: z + 0.1 };
    } else if (f.kind === 'console') {
      globe = { x: x + 17, y: y - 13, z: z + 0.2 };
    } else if (f.kind === 'tower') {
      towerLight = { x: x + 7, y: y, z: z + 0.1 };
    } else if (f.kind === 'dish') {
      dishWave = { x: x + 15, y: y - 9, z: z + 0.1 };
    } else if (f.kind === 'arcade') {
      arcade = { x, y, z };
    } else if (f.kind === 'counter') {
      steam.push({ x: x + 23, y: y - 5, z: z + 0.1 });
    } else if (f.kind === 'tableCopa') {
      steam.push({ x: x + 7, y: y + 3, z: z + 0.1 });
      steam.push({ x: x + 22, y: y + 8, z: z + 0.1 });
    } else if (f.kind === 'lamp') {
      lamps.push({ x: x + 7, y: y + 5 });
    }
  }

  // Monitores das mesas.
  const screens = new Map<number, Anchor>();
  const deskLeds = new Map<number, Anchor>();
  for (const d of office.desks) {
    if (!d.pod) continue;
    const px = d.pod.x * TILE + d.column * TILE;
    const py = d.pod.y * TILE;
    const z = (d.pod.y + 2) * TILE + 0.1;
    if (d.screenVisible) screens.set(d.index, { x: px + 3, y: py + 5, z });
    else deskLeds.set(d.index, { x: px + 12, y: py + 10, z });
  }

  // Parede.
  const windows: { x: number; y: number }[] = [];
  let clock = { x: 0, y: 0 };
  let whiteboard = { x: 0, y: 0 };
  let door = { x: 0, y: 0 };
  let tv = { x: 0, y: 0 };
  for (const d of office.decor) {
    const X = d.x * TILE;
    switch (d.kind) {
      case 'window':
        windows.push({ x: X, y: 19 });
        break;
      case 'clock':
        clock = { x: X, y: 20 };
        wall.push({ frame: 'clock', x: X, y: 20, z: 0 });
        break;
      case 'whiteboard':
        whiteboard = { x: X, y: 18 };
        break;
      case 'door':
        door = { x: X, y: 16 };
        break;
      case 'tv':
        tv = { x: X, y: 19 };
        break;
      case 'poster':
        wall.push({ frame: 'poster', x: X, y: 21, z: 0 });
        break;
      case 'ac':
        wall.push({ frame: 'ac', x: X, y: 18, z: 0 });
        break;
    }
  }

  return {
    base: drawBase(office),
    atlas,
    placements,
    wall,
    screens,
    deskLeds,
    rackLeds,
    windows,
    clock,
    whiteboard,
    door,
    tv,
    globe,
    towerLight,
    dishWave,
    crt,
    arcade,
    steam,
    lamps,
  };
}
