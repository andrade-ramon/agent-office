import { needsAttention, type SessionState, type SessionStatus } from '@agent-office/server/schema';
import { STATUS_ORDER } from './i18n';
import type { AgentFilter } from './prefs';

/** Funções puras sobre a lista de sessões (ordenação, filtros, contagens). */

export function matchesFilter(s: SessionState, agent: AgentFilter, project: string): boolean {
  if (agent !== 'all' && s.agent !== agent) return false;
  if (project && s.project !== project) return false;
  return true;
}

export function countByStatus(sessions: Iterable<SessionState>): Record<SessionStatus, number> {
  const counts: Record<SessionStatus, number> = {
    starting: 0,
    thinking: 0,
    working: 0,
    waiting_input: 0,
    permission_wait: 0,
    error: 0,
    done: 0,
    idle: 0,
    ended: 0,
  };
  for (const s of sessions) counts[s.status]++;
  return counts;
}

/** Sessões que esperam o usuário, a mais antiga primeiro. */
export function attentionList(sessions: Iterable<SessionState>): SessionState[] {
  const list: SessionState[] = [];
  for (const s of sessions) if (needsAttention(s.status)) list.push(s);
  return list.sort((a, b) => a.statusSince - b.statusSince);
}

export interface ProjectCount {
  project: string;
  count: number;
}

export function projectCounts(sessions: Iterable<SessionState>): ProjectCount[] {
  const map = new Map<string, number>();
  for (const s of sessions) {
    if (!s.project) continue;
    map.set(s.project, (map.get(s.project) ?? 0) + 1);
  }
  return [...map].map(([project, count]) => ({ project, count })).sort((a, b) => a.project.localeCompare(b.project, 'pt-BR'));
}

const RANK = new Map<SessionStatus, number>(STATUS_ORDER.map((s, i) => [s, i]));

function rank(s: SessionState): number {
  return RANK.get(s.status) ?? 99;
}

export interface ListRow {
  session: SessionState;
  /** 0 = sessão principal, 1 = subagente listado abaixo do pai. */
  depth: 0 | 1;
  /** Não passa no filtro atual. */
  dimmed: boolean;
}

/**
 * Linhas da barra lateral: quem precisa de atenção primeiro, subagentes logo
 * abaixo do pai. Sessões fora do filtro são omitidas.
 */
export function buildRows(
  sessions: Iterable<SessionState>,
  visible: (s: SessionState) => boolean = () => true,
): ListRow[] {
  const all = [...sessions].filter(visible);
  const byKey = new Map(all.map((s) => [s.key, s]));
  const children = new Map<string, SessionState[]>();
  const roots: SessionState[] = [];
  for (const s of all) {
    if (s.parentKey && byKey.has(s.parentKey)) {
      const list = children.get(s.parentKey) ?? [];
      list.push(s);
      children.set(s.parentKey, list);
    } else {
      roots.push(s);
    }
  }
  const groupRank = (root: SessionState): number => {
    let r = rank(root);
    for (const c of children.get(root.key) ?? []) if (needsAttention(c.status)) r = Math.min(r, rank(c));
    return r;
  };
  roots.sort((a, b) => {
    const ra = groupRank(a);
    const rb = groupRank(b);
    if (ra !== rb) return ra - rb;
    if (needsAttention(a.status) && needsAttention(b.status)) return a.statusSince - b.statusSince;
    if (b.lastActivityAt !== a.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
    return a.key.localeCompare(b.key);
  });
  const rows: ListRow[] = [];
  for (const root of roots) {
    rows.push({ session: root, depth: 0, dimmed: false });
    const kids = (children.get(root.key) ?? []).sort((a, b) => a.startedAt - b.startedAt || a.key.localeCompare(b.key));
    for (const k of kids) rows.push({ session: k, depth: 1, dimmed: false });
  }
  return rows;
}
