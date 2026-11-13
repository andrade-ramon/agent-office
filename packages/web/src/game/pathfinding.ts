import type { Point } from './types';

/**
 * Grade de custos: 0 = bloqueado, >0 = custo para entrar no tile.
 */
export interface Grid {
  w: number;
  h: number;
  cost: Uint8Array;
}

const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];
/** Pequena penalidade por curva: caminhos mais retos parecem mais naturais. */
const TURN_PENALTY = 0.35;

export function isWalkable(grid: Grid, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < grid.w && y < grid.h && grid.cost[y * grid.w + x]! > 0;
}

/** Heap binário mínimo sobre (prioridade, nó). */
class MinHeap {
  private readonly nodes: number[] = [];
  private readonly prio: number[] = [];

  get size(): number {
    return this.nodes.length;
  }

  push(node: number, priority: number): void {
    const nodes = this.nodes;
    const prio = this.prio;
    let i = nodes.length;
    nodes.push(node);
    prio.push(priority);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (prio[parent]! <= priority) break;
      nodes[i] = nodes[parent]!;
      prio[i] = prio[parent]!;
      i = parent;
    }
    nodes[i] = node;
    prio[i] = priority;
  }

  pop(): number {
    const nodes = this.nodes;
    const prio = this.prio;
    const top = nodes[0]!;
    const lastNode = nodes.pop()!;
    const lastPrio = prio.pop()!;
    const n = nodes.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let child = i * 2 + 1;
        if (child >= n) break;
        if (child + 1 < n && prio[child + 1]! < prio[child]!) child++;
        if (prio[child]! >= lastPrio) break;
        nodes[i] = nodes[child]!;
        prio[i] = prio[child]!;
        i = child;
      }
      nodes[i] = lastNode;
      prio[i] = lastPrio;
    }
    return top;
  }
}

/**
 * A* em grade com 4 vizinhos. Retorna os tiles do caminho, sem o inicial e
 * com o final; `[]` se início == fim; `null` se não há caminho.
 * O tile inicial pode estar bloqueado (o personagem só precisa sair dele).
 */
export function findPath(grid: Grid, sx: number, sy: number, gx: number, gy: number): Point[] | null {
  const { w, h, cost } = grid;
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
  if (!isWalkable(grid, gx, gy)) return null;
  if (sx === gx && sy === gy) return [];

  const size = w * h;
  const g = new Float32Array(size).fill(Infinity);
  const from = new Int32Array(size).fill(-1);
  const dirOf = new Int8Array(size).fill(-1);
  const closed = new Uint8Array(size);
  const start = sy * w + sx;
  const goal = gy * w + gx;
  const heap = new MinHeap();
  g[start] = 0;
  heap.push(start, 0);

  while (heap.size > 0) {
    const cur = heap.pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % w;
    const cy = (cur - cx) / w;
    const curDir = dirOf[cur]!;
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d]!;
      const ny = cy + DY[d]!;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      const c = cost[n]!;
      if (c === 0 || closed[n]) continue;
      const ng = g[cur]! + c + (curDir !== -1 && curDir !== d ? TURN_PENALTY : 0);
      if (ng < g[n]!) {
        g[n] = ng;
        from[n] = cur;
        dirOf[n] = d;
        // Heurística admissível: custo mínimo de um tile é 1.
        heap.push(n, ng + Math.abs(nx - gx) + Math.abs(ny - gy));
      }
    }
  }

  if (from[goal] === -1) return null;
  const path: Point[] = [];
  for (let n = goal; n !== start; n = from[n]!) {
    const x = n % w;
    path.push({ x, y: (n - x) / w });
  }
  path.reverse();
  return path;
}

/** Custo acumulado de um caminho (útil em testes). */
export function pathCost(grid: Grid, path: readonly Point[]): number {
  let total = 0;
  for (const p of path) total += grid.cost[p.y * grid.w + p.x]!;
  return total;
}
