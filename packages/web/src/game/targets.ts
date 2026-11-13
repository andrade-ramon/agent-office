import type { SessionState, ToolCategory } from '@agent-office/server/schema';
import type { AreaId } from './types';

/**
 * Mapeamento puro: estado da sessão → para onde o personagem vai e o que faz.
 */

export type Activity =
  | 'arrive'
  | 'think'
  | 'type'
  | 'read'
  | 'search'
  | 'bash'
  | 'plan'
  | 'web'
  | 'meet'
  | 'permission'
  | 'wait'
  | 'done'
  | 'error'
  | 'idle'
  | 'leave';

/** `stay` = fica onde está. */
export type TargetArea = AreaId | 'stay';

export interface Target {
  area: TargetArea;
  activity: Activity;
}

export type TargetInput = Pick<SessionState, 'status' | 'toolCategory' | 'toolName' | 'parentKey' | 'subagents'>;

/** Ferramentas de delegação: quem as usa vai para a sala de reunião. */
export const DELEGATION_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task', 'spawn_agent']);

export function isDelegationTool(toolName: string | null | undefined): boolean {
  return Boolean(toolName && DELEGATION_TOOLS.has(toolName));
}

const CATEGORY_TARGET: Record<ToolCategory, { area: AreaId | 'home'; activity: Activity }> = {
  write: { area: 'home', activity: 'type' },
  edit: { area: 'home', activity: 'type' },
  other: { area: 'home', activity: 'type' },
  read: { area: 'shelf', activity: 'read' },
  search: { area: 'archive', activity: 'search' },
  bash: { area: 'server', activity: 'bash' },
  plan: { area: 'board', activity: 'plan' },
  web: { area: 'web', activity: 'web' },
};

/** Área "base": mesa própria para sessões principais, sala de reunião para subagentes. */
export function homeArea(s: Pick<SessionState, 'parentKey'>): AreaId {
  return s.parentKey ? 'meeting' : 'desk';
}

export function targetFor(s: TargetInput): Target {
  const home = homeArea(s);
  switch (s.status) {
    case 'starting':
      return { area: home, activity: 'arrive' };
    case 'thinking':
      if (s.parentKey || s.subagents > 0) return { area: 'meeting', activity: 'think' };
      return { area: 'desk', activity: 'think' };
    case 'working': {
      if (isDelegationTool(s.toolName)) return { area: 'meeting', activity: 'meet' };
      const t = CATEGORY_TARGET[s.toolCategory ?? 'other'] ?? CATEGORY_TARGET.other;
      return { area: t.area === 'home' ? home : t.area, activity: t.activity };
    }
    case 'permission_wait':
      return { area: 'stay', activity: 'permission' };
    case 'waiting_input':
      return { area: home, activity: 'wait' };
    case 'done':
      return { area: home, activity: 'done' };
    case 'error':
      return { area: home, activity: 'error' };
    case 'idle':
      return { area: 'copa', activity: 'idle' };
    case 'ended':
      return { area: 'door', activity: 'leave' };
    default:
      return { area: home, activity: 'think' };
  }
}

const WORK: ReadonlySet<Activity> = new Set<Activity>(['type', 'read', 'search', 'bash', 'plan', 'web', 'meet']);

/** Atividades de ferramenta (o personagem está "trabalhando" em uma estação). */
export function isWorkActivity(a: Activity): boolean {
  return WORK.has(a);
}

export function sameTarget(a: Target, b: Target): boolean {
  return a.area === b.area && a.activity === b.activity;
}
