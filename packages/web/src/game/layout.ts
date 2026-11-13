import type { Grid } from './pathfinding';
import type { AreaId, Dir, SeatKind, Slot } from './types';

/**
 * Planta do escritório: paredes, pisos, móveis e vagas. Dados puros (sem
 * DOM / Pixi) para poderem ser testados e usados pelo pathfinding.
 */

export const TILE = 16;
export const MAP_W = 44;
export const MAP_H = 28;

export type TileKind = 'floor' | 'cap' | 'face' | 'door';
export type FloorKind = 'wood' | 'server' | 'carpet' | 'library' | 'copa';

export type FurnitureKind =
  | 'rack'
  | 'terminal'
  | 'pod'
  | 'plant'
  | 'bookshelf'
  | 'cabinet'
  | 'tableRead'
  | 'tableMeet'
  | 'counter'
  | 'fridge'
  | 'cooler'
  | 'vending'
  | 'tableCopa'
  | 'coffeeTable'
  | 'console'
  | 'tower'
  | 'dish'
  | 'bench'
  | 'arcade'
  | 'copier'
  | 'lamp'
  | 'chair'
  | 'stool'
  | 'sofa'
  | 'puff';

export type DecorKind = 'whiteboard' | 'door' | 'window' | 'clock' | 'poster' | 'tv' | 'ac';

export interface Furniture {
  kind: FurnitureKind;
  x: number;
  y: number;
  w: number;
  h: number;
  variant: number;
  dir: Dir;
}

export interface Decor {
  kind: DecorKind;
  /** Tile da esquerda; a decoração fica na face da parede (linhas 1–2). */
  x: number;
  w: number;
}

export interface Rug {
  x: number;
  y: number;
  w: number;
  h: number;
  style: 'web' | 'lounge' | 'library' | 'mat' | 'meeting';
}

export interface Desk extends Slot {
  index: number;
  /** Ilha (ou bancada) a que a mesa pertence — sessões do mesmo projeto ficam juntas. */
  group: number;
  /** Tile superior-esquerdo da ilha, quando a mesa faz parte de uma. */
  pod: { x: number; y: number } | null;
  /** Coluna do monitor dentro da ilha (0–3), -1 na bancada. */
  column: number;
  /** A tela do monitor é visível (personagem de costas para a câmera). */
  screenVisible: boolean;
}

export interface LightSpot {
  /** Em tiles (pode ser fracionário). */
  x: number;
  y: number;
  radius: number;
  color: number;
}

export interface AreaLabel {
  text: string;
  hint: string;
  x: number;
  y: number;
}

export interface OfficeLayout extends Grid {
  tiles: TileKind[];
  floors: FloorKind[];
  furniture: Furniture[];
  decor: Decor[];
  rugs: Rug[];
  slots: Record<AreaId, Slot[]>;
  desks: Desk[];
  lights: LightSpot[];
  fans: { x: number; y: number }[];
  labels: AreaLabel[];
}

export const COST_FLOOR = 2;
export const COST_SEAT = 7;

const SOLID: ReadonlySet<FurnitureKind> = new Set<FurnitureKind>([
  'rack',
  'terminal',
  'pod',
  'plant',
  'bookshelf',
  'cabinet',
  'tableRead',
  'tableMeet',
  'counter',
  'fridge',
  'cooler',
  'vending',
  'tableCopa',
  'coffeeTable',
  'console',
  'tower',
  'dish',
  'bench',
  'arcade',
  'copier',
  'lamp',
]);

/** Deslocamento de quem está sentado, para "encaixar" na mesa. */
function seatOffset(facing: Dir, seat: SeatKind): { ox: number; oy: number } {
  if (seat === 'stand') return { ox: 0, oy: 0 };
  if (seat === 'sofa') return { ox: 0, oy: -2 };
  switch (facing) {
    case 'down':
      return { ox: 0, oy: 5 };
    case 'up':
      return { ox: 0, oy: -4 };
    case 'right':
      return { ox: 3, oy: 0 };
    case 'left':
      return { ox: -3, oy: 0 };
  }
}

export function buildOffice(): OfficeLayout {
  const w = MAP_W;
  const h = MAP_H;
  const tiles: TileKind[] = new Array<TileKind>(w * h).fill('floor');
  const floors: FloorKind[] = new Array<FloorKind>(w * h).fill('wood');
  const solid = new Uint8Array(w * h);
  const seats = new Uint8Array(w * h);
  const furniture: Furniture[] = [];
  const decor: Decor[] = [];
  const rugs: Rug[] = [];
  const desks: Desk[] = [];
  const slots: Record<AreaId, Slot[]> = {
    desk: [],
    shelf: [],
    archive: [],
    server: [],
    board: [],
    web: [],
    copa: [],
    meeting: [],
    door: [],
  };

  const at = (x: number, y: number): number => y * w + x;
  const fill = (x0: number, y0: number, x1: number, y1: number, kind: TileKind): void => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles[at(x, y)] = kind;
  };
  const zone = (x0: number, y0: number, x1: number, y1: number, kind: FloorKind): void => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) floors[at(x, y)] = kind;
  };

  // ───────────── paredes ─────────────
  fill(0, 0, w - 1, 0, 'cap');
  fill(1, 1, w - 2, 2, 'face');
  fill(0, 0, 0, h - 1, 'cap');
  fill(w - 1, 0, w - 1, h - 1, 'cap');
  fill(0, h - 1, w - 1, h - 1, 'cap');
  // sala de servidores (canto superior esquerdo)
  fill(10, 0, 10, 10, 'cap');
  fill(0, 10, 10, 10, 'cap');
  fill(1, 11, 10, 11, 'face');
  // sala de reunião (canto superior direito)
  fill(33, 0, 33, 10, 'cap');
  fill(33, 10, w - 1, 10, 'cap');
  fill(33, 11, w - 2, 11, 'face');
  // passagens
  for (const y of [6, 7]) {
    tiles[at(10, y)] = 'floor';
    tiles[at(33, y)] = 'floor';
  }
  // porta de entrada (na parede de cima)
  tiles[at(21, 2)] = 'door';
  tiles[at(22, 2)] = 'door';

  // ───────────── pisos ─────────────
  zone(1, 3, 10, 9, 'server');
  zone(33, 3, 42, 9, 'carpet');
  zone(1, 12, 10, 26, 'library');
  zone(33, 12, 42, 26, 'copa');

  // ───────────── helpers de mobília ─────────────
  const put = (kind: FurnitureKind, x: number, y: number, fw = 1, fh = 1, variant = 0, dir: Dir = 'down'): void => {
    furniture.push({ kind, x, y, w: fw, h: fh, variant, dir });
    for (let yy = y; yy < y + fh; yy++) {
      for (let xx = x; xx < x + fw; xx++) {
        if (SOLID.has(kind)) solid[at(xx, yy)] = 1;
        else seats[at(xx, yy)] = 1;
      }
    }
  };

  const slot = (
    area: AreaId,
    x: number,
    y: number,
    facing: Dir,
    seat: SeatKind,
    tag: string,
    rank = 0,
  ): Slot => {
    const { ox, oy } = seatOffset(facing, seat);
    const s: Slot = { id: `${area}:${x},${y}`, area, x, y, facing, seat, ox, oy, tag, rank };
    slots[area].push(s);
    return s;
  };

  /** Cadeira (ou banco) + vaga. */
  const seatAt = (
    area: AreaId,
    x: number,
    y: number,
    facing: Dir,
    tag: string,
    style: number,
    rank = 0,
    seat: SeatKind = 'chair',
  ): Slot => {
    put(seat === 'stool' ? 'stool' : 'chair', x, y, 1, 1, style, facing);
    return slot(area, x, y, facing, seat, tag, rank);
  };

  // ───────────── sala de servidores (bash) ─────────────
  for (let x = 1; x <= 6; x++) {
    put('rack', x, 3, 1, 1, x % 3);
    slot('server', x, 4, 'up', 'stand', 'rack');
  }
  put('terminal', 8, 3, 2, 1);
  slot('server', 8, 4, 'up', 'stand', 'terminal');
  slot('server', 9, 4, 'up', 'stand', 'terminal', 1);
  for (let x = 2; x <= 5; x++) {
    put('rack', x, 7, 1, 1, (x + 1) % 3);
    slot('server', x, 8, 'up', 'stand', 'rack', 1);
  }
  decor.push({ kind: 'ac', x: 8, w: 2 });

  // ───────────── quadro branco (planejando) ─────────────
  decor.push({ kind: 'poster', x: 11, w: 2 });
  decor.push({ kind: 'whiteboard', x: 13, w: 4 });
  for (let x = 13; x <= 16; x++) slot('board', x, 3, 'up', 'stand', 'write');
  for (let x = 13; x <= 16; x++) slot('board', x, 4, 'up', 'stand', 'watch', 1);

  // ───────────── entrada ─────────────
  decor.push({ kind: 'clock', x: 19, w: 1 });
  decor.push({ kind: 'door', x: 21, w: 2 });
  slot('door', 21, 2, 'down', 'stand', 'door');
  slot('door', 22, 2, 'down', 'stand', 'door');
  rugs.push({ x: 21, y: 3, w: 2, h: 1, style: 'mat' });
  for (const x of [24, 27, 30]) decor.push({ kind: 'window', x, w: 2 });
  put('plant', 11, 3, 1, 1, 0);
  put('plant', 32, 3, 1, 1, 1);

  // ───────────── mesas (ilhas de 4) ─────────────
  let group = 0;
  for (const py of [6, 13]) {
    for (const px of [14, 20, 26]) {
      put('pod', px, py + 1, 4, 2, group);
      // Fileira de cima: sentam atrás da ilha, de frente para a câmera.
      for (const col of [0, 2]) {
        put('chair', px + col, py, 1, 1, 0, 'down');
        const { ox, oy } = seatOffset('down', 'chair');
        desks.push({
          id: `desk:${px + col},${py}`,
          area: 'desk',
          x: px + col,
          y: py,
          facing: 'down',
          seat: 'chair',
          ox,
          oy,
          tag: 'pod',
          rank: 0,
          index: desks.length,
          group,
          pod: { x: px, y: py + 1 },
          column: col,
          screenVisible: false,
        });
      }
      // Fileira de baixo: de costas para a câmera, a tela aparece.
      for (const col of [1, 3]) {
        put('chair', px + col, py + 3, 1, 1, 0, 'up');
        const { ox, oy } = seatOffset('up', 'chair');
        desks.push({
          id: `desk:${px + col},${py + 3}`,
          area: 'desk',
          x: px + col,
          y: py + 3,
          facing: 'up',
          seat: 'chair',
          ox,
          oy,
          tag: 'pod',
          rank: 0,
          index: desks.length,
          group,
          pod: { x: px, y: py + 1 },
          column: col,
          screenVisible: true,
        });
      }
      group++;
    }
  }

  // ───────────── bancada (mesas extras junto à parede de baixo) ─────────────
  for (const bx of [12, 26]) {
    put('bench', bx, 26, 6, 1, group);
    for (let i = 0; i < 6; i++) {
      put('stool', bx + i, 25, 1, 1, 1, 'down');
      const { ox, oy } = seatOffset('down', 'stool');
      desks.push({
        id: `desk:${bx + i},25`,
        area: 'desk',
        x: bx + i,
        y: 25,
        facing: 'down',
        seat: 'stool',
        ox,
        oy,
        tag: 'bench',
        rank: 1,
        index: desks.length,
        group,
        pod: null,
        column: -1,
        screenVisible: false,
      });
    }
    group++;
  }
  slots.desk = desks;

  // ───────────── estação web ─────────────
  rugs.push({ x: 18, y: 19, w: 7, h: 5, style: 'web' });
  put('tower', 19, 20);
  put('console', 20, 20, 3, 1);
  put('dish', 23, 20);
  for (let x = 20; x <= 22; x++) slot('web', x, 21, 'up', 'stand', 'console');
  slot('web', 19, 21, 'up', 'stand', 'antenna', 1);
  slot('web', 23, 21, 'up', 'stand', 'antenna', 1);
  for (let x = 20; x <= 22; x++) slot('web', x, 22, 'up', 'stand', 'watch', 2);

  // ───────────── sala de reunião (subagentes) ─────────────
  rugs.push({ x: 35, y: 4, w: 7, h: 4, style: 'meeting' });
  put('tableMeet', 36, 5, 5, 2);
  for (let x = 36; x <= 40; x++) seatAt('meeting', x, 4, 'down', 'table', 1);
  for (let x = 36; x <= 40; x++) seatAt('meeting', x, 7, 'up', 'table', 1);
  for (const y of [5, 6]) seatAt('meeting', 35, y, 'right', 'table', 1);
  for (const y of [5, 6]) seatAt('meeting', 41, y, 'left', 'table', 1);
  slot('meeting', 34, 4, 'right', 'stand', 'stand', 2);
  slot('meeting', 42, 4, 'left', 'stand', 'stand', 2);
  slot('meeting', 34, 8, 'right', 'stand', 'stand', 2);
  slot('meeting', 42, 8, 'left', 'stand', 'stand', 2);
  for (const x of [35, 37, 39, 41]) slot('meeting', x, 9, 'up', 'stand', 'stand', 2);
  decor.push({ kind: 'window', x: 34, w: 2 });
  decor.push({ kind: 'tv', x: 37, w: 3 });
  decor.push({ kind: 'window', x: 41, w: 2 });

  // ───────────── estante / arquivo (lendo / buscando) ─────────────
  for (let x = 1; x <= 4; x++) {
    put('cabinet', x, 12, 1, 1, x % 2);
    slot('archive', x, 13, 'up', 'stand', 'cabinet');
  }
  for (let x = 5; x <= 9; x++) {
    put('bookshelf', x, 12, 1, 1, x % 4);
    slot('shelf', x, 13, 'up', 'stand', 'shelf');
  }
  for (let x = 2; x <= 5; x++) {
    put('cabinet', x, 17, 1, 1, 2 + (x % 2));
    slot('archive', x, 18, 'up', 'stand', 'cabinet', 1);
  }
  for (let x = 6; x <= 8; x++) {
    put('bookshelf', x, 17, 1, 1, (x + 2) % 4);
    slot('shelf', x, 18, 'up', 'stand', 'shelf', 1);
  }
  rugs.push({ x: 2, y: 21, w: 6, h: 3, style: 'library' });
  put('tableRead', 3, 22, 4, 1);
  for (let x = 3; x <= 6; x++) seatAt('shelf', x, 21, 'down', 'table', 2, 2);
  for (let x = 3; x <= 6; x++) seatAt('shelf', x, 23, 'up', 'table', 2, 2);
  put('lamp', 9, 21);
  put('plant', 1, 26, 1, 1, 2);
  put('plant', 9, 26, 1, 1, 0);

  // ───────────── copa (ociosos) ─────────────
  put('fridge', 34, 12);
  put('counter', 35, 12, 5, 1);
  put('cooler', 41, 12);
  put('vending', 42, 12);
  slot('copa', 36, 13, 'up', 'stand', 'coffee');
  slot('copa', 35, 13, 'down', 'stand', 'cup');
  slot('copa', 38, 13, 'down', 'stand', 'cup');
  slot('copa', 41, 13, 'up', 'stand', 'water');
  put('tableCopa', 37, 16, 2, 2);
  for (const x of [37, 38]) seatAt('copa', x, 15, 'down', 'table', 3, 0, 'stool');
  for (const x of [37, 38]) seatAt('copa', x, 18, 'up', 'table', 3, 0, 'stool');
  for (const y of [16, 17]) seatAt('copa', 36, y, 'right', 'table', 3, 0, 'stool');
  for (const y of [16, 17]) seatAt('copa', 39, y, 'left', 'table', 3, 0, 'stool');
  rugs.push({ x: 34, y: 21, w: 6, h: 5, style: 'lounge' });
  put('sofa', 35, 22, 4, 1);
  for (let x = 35; x <= 38; x++) slot('copa', x, 22, 'down', 'sofa', 'sofa');
  put('coffeeTable', 36, 24, 2, 1);
  put('puff', 40, 23, 1, 1, 0);
  slot('copa', 40, 23, 'down', 'sofa', 'puff');
  put('puff', 41, 25, 1, 1, 1);
  slot('copa', 41, 25, 'down', 'sofa', 'puff');
  put('plant', 42, 26, 1, 1, 1);
  put('plant', 33, 26, 1, 1, 2);

  // ───────────── decoração da área aberta ─────────────
  put('copier', 12, 20);
  put('plant', 11, 26, 1, 1, 1);
  put('plant', 19, 26, 1, 1, 0);
  put('plant', 24, 26, 1, 1, 2);
  put('plant', 32, 26, 1, 1, 0);
  put('arcade', 31, 20);
  put('plant', 11, 18, 1, 1, 2);
  put('plant', 32, 18, 1, 1, 1);

  // ───────────── grade de custos ─────────────
  const cost = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const kind = tiles[i]!;
    if (kind === 'cap' || kind === 'face' || solid[i]) cost[i] = 0;
    else if (seats[i]) cost[i] = COST_SEAT;
    else cost[i] = COST_FLOOR;
  }

  const lights: LightSpot[] = [
    { x: 16, y: 8, radius: 4.2, color: 0xffe2a8 },
    { x: 22, y: 8, radius: 4.2, color: 0xffe2a8 },
    { x: 28, y: 8, radius: 4.2, color: 0xffe2a8 },
    { x: 16, y: 15, radius: 4.2, color: 0xffe2a8 },
    { x: 22, y: 15, radius: 4.2, color: 0xffe2a8 },
    { x: 28, y: 15, radius: 4.2, color: 0xffe2a8 },
    { x: 22, y: 4, radius: 3, color: 0xfff0c8 },
    { x: 15, y: 4, radius: 3, color: 0xfff0c8 },
    { x: 5.5, y: 6, radius: 4.5, color: 0x8fc8ff },
    { x: 38.5, y: 6, radius: 4.5, color: 0xffe2a8 },
    { x: 5, y: 15, radius: 4, color: 0xffd9a0 },
    { x: 5, y: 22.5, radius: 3.6, color: 0xffd08a },
    { x: 37.5, y: 14, radius: 4, color: 0xffe2a8 },
    { x: 37.5, y: 22, radius: 4, color: 0xffcf96 },
    { x: 21.5, y: 21, radius: 4, color: 0x8fe8ff },
    { x: 15, y: 25, radius: 3.4, color: 0xffe2a8 },
    { x: 29, y: 25, radius: 3.4, color: 0xffe2a8 },
  ];

  const labels: AreaLabel[] = [
    { text: 'Servidores', hint: 'terminal', x: 5.5, y: 5.6 },
    { text: 'Quadro', hint: 'planejando', x: 15, y: 5.4 },
    { text: 'Porta', hint: 'entrada e saída', x: 22, y: 4.4 },
    { text: 'Mesas', hint: 'escrevendo e editando', x: 22, y: 11.6 },
    { text: 'Reunião', hint: 'subagentes', x: 38.5, y: 9.3 },
    { text: 'Arquivo', hint: 'buscando', x: 2.7, y: 15.4 },
    { text: 'Estante', hint: 'lendo', x: 7.6, y: 15.4 },
    { text: 'Estação web', hint: 'web', x: 21.5, y: 24.3 },
    { text: 'Copa', hint: 'ociosos', x: 38, y: 20.3 },
    { text: 'Bancada', hint: 'mesas extras', x: 15, y: 24.3 },
  ];

  return {
    w,
    h,
    cost,
    tiles,
    floors,
    furniture,
    decor,
    rugs,
    slots,
    desks,
    lights,
    fans: [
      { x: 19, y: 11.5 },
      { x: 25, y: 11.5 },
    ],
    labels,
  };
}

/** Planta única usada pelo app. */
export const OFFICE: OfficeLayout = buildOffice();

/** Centro de um tile em pixels (ponto dos pés do personagem). */
export function tileFeet(x: number, y: number): { x: number; y: number } {
  return { x: x * TILE + TILE / 2, y: y * TILE + TILE - 2 };
}

/** Desenha a planta em ASCII (depuração e testes). */
export function renderAscii(office: OfficeLayout): string {
  const rows: string[] = [];
  const slotAt = new Map<number, string>();
  const mark: Record<AreaId, string> = {
    desk: 'd',
    shelf: 'r',
    archive: 's',
    server: 'b',
    board: 'p',
    web: 'w',
    copa: 'c',
    meeting: 'm',
    door: 'D',
  };
  for (const area of Object.keys(office.slots) as AreaId[]) {
    for (const s of office.slots[area]) slotAt.set(s.y * office.w + s.x, mark[area]);
  }
  for (let y = 0; y < office.h; y++) {
    let row = '';
    for (let x = 0; x < office.w; x++) {
      const i = y * office.w + x;
      const kind = office.tiles[i]!;
      if (kind === 'cap') row += '#';
      else if (kind === 'face') row += '=';
      else if (slotAt.has(i)) row += slotAt.get(i);
      else if (office.cost[i] === 0) row += 'X';
      else if (office.cost[i] === COST_SEAT) row += 'h';
      else row += '.';
    }
    rows.push(row);
  }
  return rows.join('\n');
}
