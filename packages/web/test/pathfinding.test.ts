import { describe, expect, it } from 'vitest';
import { COST_SEAT, OFFICE, renderAscii } from '../src/game/layout';
import { findPath, isWalkable, pathCost, type Grid } from '../src/game/pathfinding';
import { AREA_IDS } from '../src/game/types';

/** Monta uma grade a partir de um desenho: '#' bloqueado, '.' livre, dígito = custo. */
function grid(rows: string[]): Grid {
  const h = rows.length;
  const w = rows[0]!.length;
  const cost = new Uint8Array(w * h);
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x]!;
      cost[y * w + x] = ch === '#' ? 0 : ch === '.' ? 1 : Number(ch);
    }
  });
  return { w, h, cost };
}

function assertContiguous(g: Grid, sx: number, sy: number, path: { x: number; y: number }[]): void {
  let px = sx;
  let py = sy;
  for (const p of path) {
    expect(Math.abs(p.x - px) + Math.abs(p.y - py)).toBe(1);
    expect(isWalkable(g, p.x, p.y)).toBe(true);
    px = p.x;
    py = p.y;
  }
}

describe('findPath', () => {
  it('retorna caminho vazio quando início e fim coincidem', () => {
    const g = grid(['...', '...']);
    expect(findPath(g, 1, 1, 1, 1)).toEqual([]);
  });

  it('anda em linha reta quando não há obstáculos', () => {
    const g = grid(['.....', '.....', '.....']);
    const path = findPath(g, 0, 1, 4, 1)!;
    expect(path).toHaveLength(4);
    expect(path.every((p) => p.y === 1)).toBe(true);
    expect(path.at(-1)).toEqual({ x: 4, y: 1 });
  });

  it('contorna paredes sem atravessá-las', () => {
    const g = grid([
      '.....',
      '####.',
      '...#.',
      '.#.#.',
      '.#...',
    ]);
    const path = findPath(g, 0, 0, 0, 2)!;
    expect(path).not.toBeNull();
    assertContiguous(g, 0, 0, path);
    expect(path.at(-1)).toEqual({ x: 0, y: 2 });
    // único acesso é dando a volta pela direita e por baixo
    expect(path.some((p) => p.x === 4 && p.y === 2)).toBe(true);
    expect(path).toHaveLength(14);
  });

  it('retorna null quando o destino é inalcançável ou bloqueado', () => {
    const g = grid(['..#..', '..#..', '..#..']);
    expect(findPath(g, 0, 0, 4, 0)).toBeNull();
    expect(findPath(g, 0, 0, 2, 1)).toBeNull();
    expect(findPath(g, -1, 0, 1, 0)).toBeNull();
  });

  it('prefere tiles baratos a tiles caros (cadeiras)', () => {
    const g = grid([
      '.....',
      '.999.',
      '.....',
    ]);
    const path = findPath(g, 0, 1, 4, 1)!;
    expect(pathCost(g, path)).toBeLessThan(9);
    expect(path.some((p) => g.cost[p.y * g.w + p.x] === 9)).toBe(false);
  });

  it('consegue sair de um tile inicial bloqueado', () => {
    const g = grid(['#..', '...']);
    const path = findPath(g, 0, 0, 2, 1)!;
    expect(path.at(-1)).toEqual({ x: 2, y: 1 });
  });

  it('faz poucas curvas em área aberta', () => {
    const g = grid(Array.from({ length: 8 }, () => '........'));
    const path = findPath(g, 0, 0, 7, 7)!;
    expect(path).toHaveLength(14);
    let turns = 0;
    let prev = { x: 0, y: 0 };
    let lastDir = '';
    for (const p of path) {
      const dir = `${p.x - prev.x},${p.y - prev.y}`;
      if (lastDir && dir !== lastDir) turns++;
      lastDir = dir;
      prev = p;
    }
    expect(turns).toBeLessThanOrEqual(2);
  });
});

describe('planta do escritório', () => {
  it('tem pelo menos 12 mesas e todas as áreas com vagas', () => {
    expect(OFFICE.desks.length).toBeGreaterThanOrEqual(12);
    for (const area of AREA_IDS) {
      expect(OFFICE.slots[area].length, area).toBeGreaterThan(0);
    }
    expect(OFFICE.slots.meeting.length).toBeGreaterThanOrEqual(8);
    expect(OFFICE.slots.server.length).toBeGreaterThanOrEqual(6);
  });

  it('não repete o mesmo tile em duas vagas', () => {
    const seen = new Set<string>();
    for (const area of AREA_IDS) {
      for (const s of OFFICE.slots[area]) {
        const id = `${s.x},${s.y}`;
        expect(seen.has(id), `${area} ${id}`).toBe(false);
        seen.add(id);
      }
    }
  });

  it('toda vaga é caminhável e alcançável a partir da porta', () => {
    const door = OFFICE.slots.door[0]!;
    for (const area of AREA_IDS) {
      for (const s of OFFICE.slots[area]) {
        expect(isWalkable(OFFICE, s.x, s.y), `${s.id} bloqueada\n${renderAscii(OFFICE)}`).toBe(true);
        const path = findPath(OFFICE, door.x, door.y, s.x, s.y);
        expect(path, `${s.id} inalcançável`).not.toBeNull();
        assertContiguous(OFFICE, door.x, door.y, path!);
      }
    }
  });

  it('caminhos não atravessam cadeiras de outras pessoas sem necessidade', () => {
    const door = OFFICE.slots.door[0]!;
    const target = OFFICE.slots.copa.find((s) => s.tag === 'coffee')!;
    const path = findPath(OFFICE, door.x, door.y, target.x, target.y)!;
    const seats = path.filter((p) => OFFICE.cost[p.y * OFFICE.w + p.x] === COST_SEAT);
    expect(seats).toHaveLength(0);
  });
});
