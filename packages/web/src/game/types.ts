/** Tipos compartilhados da simulação do escritório (sem DOM / Pixi). */

export type Dir = 'down' | 'up' | 'left' | 'right';

export interface Point {
  x: number;
  y: number;
}

/** Áreas do escritório para onde um personagem pode ir. */
export type AreaId =
  | 'desk'
  | 'shelf'
  | 'archive'
  | 'server'
  | 'board'
  | 'web'
  | 'copa'
  | 'meeting'
  | 'door';

export const AREA_IDS: readonly AreaId[] = [
  'desk',
  'shelf',
  'archive',
  'server',
  'board',
  'web',
  'copa',
  'meeting',
  'door',
];

export type SeatKind = 'stand' | 'chair' | 'stool' | 'sofa';

/** Uma vaga: tile + direção + pose. */
export interface Slot {
  id: string;
  area: AreaId;
  /** Tile. */
  x: number;
  y: number;
  facing: Dir;
  seat: SeatKind;
  /** Deslocamento em pixels quando o personagem está acomodado. */
  ox: number;
  oy: number;
  /** Variante da vaga (ex.: "rack", "coffee", "sofa", "watch"). */
  tag: string;
  /** Preferência (menor = escolhido antes). */
  rank: number;
}
