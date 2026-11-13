import type { Desk } from './layout';
import type { AreaId, Point, Slot } from './types';
import { hash32 } from './variant';

/**
 * Alocação de vagas: cada personagem ocupa no máximo uma vaga por vez; quando
 * a área lota, as vagas passam a ser compartilhadas (nunca falha).
 */

export interface Claim<S extends Slot = Slot> {
  slot: S;
  /** 0 = único/primeiro ocupante; >0 = dividindo a vaga (usar para deslocar o sprite). */
  share: number;
}

function dist(a: Point, b: Point): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export class SlotAllocator {
  private readonly occupants = new Map<string, string[]>();
  private readonly held = new Map<string, Slot>();

  constructor(private readonly slots: Record<AreaId, readonly Slot[]>) {}

  /** Vaga atual do personagem, se houver. */
  slotOf(key: string): Slot | undefined {
    return this.held.get(key);
  }

  countIn(area: AreaId): number {
    let n = 0;
    for (const s of this.held.values()) if (s.area === area) n++;
    return n;
  }

  occupantsOf(slotId: string): readonly string[] {
    return this.occupants.get(slotId) ?? [];
  }

  /**
   * Reserva uma vaga na área. Mantém a vaga atual se já for dessa área.
   * `near` (em tiles) desempata pela proximidade.
   */
  claim(key: string, area: AreaId, near: Point): Claim {
    const current = this.held.get(key);
    if (current && current.area === area) {
      return { slot: current, share: this.shareIndex(current.id, key) };
    }
    if (current) this.release(key);

    const list = this.slots[area];
    if (!list || list.length === 0) throw new Error(`área sem vagas: ${area}`);

    // Na copa as pessoas se espalham (mesa, sofá, balcão) em vez de irem todas
    // para a vaga mais próxima.
    const spread = area === 'copa' ? 14 : 1;
    let best: Slot | undefined;
    let bestScore = Infinity;
    for (const s of list) {
      const occ = this.occupants.get(s.id)?.length ?? 0;
      // Vagas livres sempre ganham; depois preferência, distância e um ruído estável.
      const score =
        occ * 100_000 + s.rank * 1000 + dist(near, s) * 4 + (hash32(`${key}|${s.id}`) % 4) * spread;
      if (score < bestScore) {
        bestScore = score;
        best = s;
      }
    }
    const chosen = best!;
    const occ = this.occupants.get(chosen.id) ?? [];
    occ.push(key);
    this.occupants.set(chosen.id, occ);
    this.held.set(key, chosen);
    return { slot: chosen, share: occ.length - 1 };
  }

  release(key: string): void {
    const current = this.held.get(key);
    if (!current) return;
    this.held.delete(key);
    const occ = this.occupants.get(current.id);
    if (!occ) return;
    const i = occ.indexOf(key);
    if (i >= 0) occ.splice(i, 1);
    if (occ.length === 0) this.occupants.delete(current.id);
  }

  private shareIndex(slotId: string, key: string): number {
    const occ = this.occupants.get(slotId);
    return occ ? Math.max(0, occ.indexOf(key)) : 0;
  }
}

/**
 * Dono de cada mesa. Sessões do mesmo projeto tendem a sentar na mesma ilha;
 * quando não há mesa livre, a mesa é compartilhada.
 */
export class DeskAllocator {
  private readonly owners = new Map<number, string[]>();
  private readonly byKey = new Map<string, { desk: Desk; project: string }>();

  constructor(private readonly desks: readonly Desk[]) {}

  deskOf(key: string): Desk | undefined {
    return this.byKey.get(key)?.desk;
  }

  ownersOf(index: number): readonly string[] {
    return this.owners.get(index) ?? [];
  }

  get assigned(): number {
    return this.byKey.size;
  }

  assign(key: string, project: string): Claim<Desk> {
    const existing = this.byKey.get(key);
    if (existing) {
      const list = this.owners.get(existing.desk.index) ?? [];
      return { slot: existing.desk, share: Math.max(0, list.indexOf(key)) };
    }
    if (this.desks.length === 0) throw new Error('escritório sem mesas');

    // Ocupação e projetos por ilha.
    const used = new Map<number, number>();
    const sameProject = new Map<number, number>();
    const size = new Map<number, number>();
    for (const d of this.desks) size.set(d.group, (size.get(d.group) ?? 0) + 1);
    for (const { desk, project: p } of this.byKey.values()) {
      used.set(desk.group, (used.get(desk.group) ?? 0) + 1);
      if (p === project) sameProject.set(desk.group, (sameProject.get(desk.group) ?? 0) + 1);
    }

    let best: Desk | undefined;
    let bestScore = Infinity;
    for (const d of this.desks) {
      const occ = this.owners.get(d.index)?.length ?? 0;
      const groupUsed = used.get(d.group) ?? 0;
      const mates = sameProject.get(d.group) ?? 0;
      const score =
        occ * 100_000 + // mesa livre primeiro
        d.rank * 10_000 + // ilhas antes da bancada
        (mates > 0 ? -500 : 0) + // perto de quem está no mesmo projeto
        (mates === 0 && groupUsed > 0 ? 200 : 0) + // senão, prefere ilha vazia
        groupUsed * 10 +
        d.index * 0.01;
      if (score < bestScore) {
        bestScore = score;
        best = d;
      }
    }
    const desk = best!;
    const list = this.owners.get(desk.index) ?? [];
    list.push(key);
    this.owners.set(desk.index, list);
    this.byKey.set(key, { desk, project });
    return { slot: desk, share: list.length - 1 };
  }

  release(key: string): void {
    const entry = this.byKey.get(key);
    if (!entry) return;
    this.byKey.delete(key);
    const list = this.owners.get(entry.desk.index);
    if (!list) return;
    const i = list.indexOf(key);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this.owners.delete(entry.desk.index);
  }
}
