import type { AgentKind, EventType, SessionState, SessionStatus, ToolCategory } from '@agent-office/server/schema';
import type { IconName } from './game/art/icons';
import type { TimeMode } from './game/daynight';
import { isDelegationTool } from './game/targets';

/** Textos (pt-BR) e formatadores usados pela interface. */

export const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: 'Iniciando',
  thinking: 'Pensando',
  working: 'Trabalhando',
  waiting_input: 'Aguardando você',
  permission_wait: 'Pedindo permissão',
  error: 'Erro',
  done: 'Concluiu',
  idle: 'Ocioso',
  ended: 'Encerrada',
};

/** Forma curta e no plural, para os contadores do cabeçalho. */
export const STATUS_COUNT_LABEL: Record<SessionStatus, string> = {
  starting: 'iniciando',
  thinking: 'pensando',
  working: 'trabalhando',
  waiting_input: 'aguardando você',
  permission_wait: 'pedindo permissão',
  error: 'com erro',
  done: 'concluíram',
  idle: 'ociosos',
  ended: 'encerradas',
};

/** Ordem de exibição (o que pede atenção vem primeiro). */
export const STATUS_ORDER: readonly SessionStatus[] = [
  'waiting_input',
  'permission_wait',
  'error',
  'working',
  'thinking',
  'starting',
  'done',
  'idle',
  'ended',
];

export const CATEGORY_LABEL: Record<ToolCategory, string> = {
  read: 'Leitura',
  write: 'Escrita',
  edit: 'Edição',
  bash: 'Terminal',
  search: 'Busca',
  web: 'Web',
  plan: 'Planejamento',
  other: 'Outra',
};

export const CATEGORY_PLACE: Record<ToolCategory, string> = {
  read: 'na estante',
  write: 'na mesa',
  edit: 'na mesa',
  bash: 'na sala de servidores',
  search: 'no arquivo',
  web: 'na estação web',
  plan: 'no quadro branco',
  other: 'na mesa',
};

export const CATEGORY_ICON: Record<ToolCategory, IconName> = {
  read: 'book',
  write: 'pencil',
  edit: 'pencil',
  bash: 'terminal',
  search: 'search',
  web: 'globe',
  plan: 'plan',
  other: 'gear',
};

export const EVENT_LABEL: Record<EventType, string> = {
  session_start: 'Sessão iniciada',
  prompt: 'Prompt recebido',
  tool_start: 'Ferramenta iniciada',
  tool_end: 'Ferramenta concluída',
  subagent_start: 'Subagente iniciado',
  subagent_stop: 'Subagente finalizado',
  waiting_input: 'Aguardando resposta',
  permission_wait: 'Pedido de permissão',
  error: 'Erro',
  stop: 'Turno concluído',
  session_end: 'Sessão encerrada',
};

export const AGENT_LABEL: Record<AgentKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

export const TIME_MODE_LABEL: Record<TimeMode, string> = {
  auto: 'Hora real',
  day: 'Dia',
  night: 'Noite',
  fast: 'Ciclo rápido',
};

export function sourceLabel(s: SessionState, demo: boolean): string {
  if (s.remote) return 'consulta à nuvem';
  const parts: string[] = [];
  if (s.sources.hook) parts.push('hooks');
  if (s.sources.watcher) parts.push('arquivo');
  if (parts.length === 0) return demo ? 'demonstração' : s.machine ? `espelhada de ${s.machine}` : '—';
  return s.machine ? `${parts.join(' + ')} · em ${s.machine}` : parts.join(' + ');
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Duração compacta: "42s", "3min 05s", "1h 12min". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}min ${pad(total % 60)}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${pad(m % 60)}min`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Tempo relativo: "agora", "há 12s", "há 4min". */
export function formatAgo(ms: number): string {
  const total = Math.floor(ms / 1000);
  if (total < 2) return 'agora';
  if (total < 60) return `há ${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `há ${m}min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `há ${h}h`;
  return `há ${Math.floor(h / 24)}d`;
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const numberFormat = new Intl.NumberFormat('pt-BR');

export function formatNumber(n: number): string {
  return numberFormat.format(n);
}

/** 45300 → "45,3 mil"; 12 864 000 000 → "12,86 bi". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 999_950) return `${(n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`;
  if (n < 999_995_000) return `${(n / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} mi`;
  return `${(n / 1_000_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} bi`;
}

/** Tempo somado, que pode passar de centenas de horas: "42 min", "8 h 05 min", "184,4 h". */
export function formatHours(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 600) return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
  return `${(minutes / 60).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`;
}

/** Como `formatHours`, mais curto para as linhas de apoio: "52 min", "1h03", "28,8 h". */
export function formatHoursShort(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 60 || minutes >= 600) return formatHours(ms);
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`;
}

/** Valor em dinheiro sem o símbolo: "34,20", "8.412", "123,5 mil", "1,23 mi". */
export function formatMoney(amount: number): string {
  const v = Math.max(0, amount);
  if (v < 100) return v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (v < 99_999.5) return formatNumber(Math.round(v));
  return formatTokens(v);
}

/** 8412.3 → "US$ 8.412". */
export function formatUsd(usd: number): string {
  return `US$ ${formatMoney(usd)}`;
}

/** 23610.4 → "R$ 23.610". */
export function formatBrl(brl: number): string {
  return `R$ ${formatMoney(brl)}`;
}

/** 1732000000000 → "18/11". */
export function formatDay(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 1732000000000 → "18/11/2026". */
export function formatDate(ts: number): string {
  return `${formatDay(ts)}/${new Date(ts).getFullYear()}`;
}

export function plural(n: number, one: string, many: string): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

/** O que o personagem está fazendo, em uma frase curta. */
export function describeActivity(s: SessionState): string {
  switch (s.status) {
    case 'working': {
      if (s.remote) return 'rodando na nuvem';
      if (isDelegationTool(s.toolName)) return 'delegando a subagentes na sala de reunião';
      const cat = s.toolCategory ?? 'other';
      const tool = s.toolName ? `${s.toolName} ` : '';
      return `${tool}${CATEGORY_PLACE[cat]}`.trim();
    }
    case 'permission_wait':
      return s.toolName ? `quer usar ${s.toolName}` : 'aguardando sua permissão';
    case 'waiting_input':
      return 'esperando sua resposta';
    case 'thinking':
      if (s.remote) return 'na bancada da nuvem';
      if (s.parentKey) return 'na sala de reunião';
      return s.subagents > 0 ? 'em reunião com subagentes' : 'na própria mesa';
    case 'starting':
      return 'chegando ao escritório';
    case 'done':
      return s.remote ? 'parou na nuvem' : 'terminou o turno';
    case 'error':
      return 'algo deu errado';
    case 'idle':
      return 'na copa';
    case 'ended':
      return 'foi embora';
    default:
      return '';
  }
}

/** Complemento curto do status para a lista (ferramenta em uso, etc.). */
export function shortActivity(s: SessionState): string {
  switch (s.status) {
    case 'working':
      if (s.remote) return 'na nuvem';
      return s.toolName ?? CATEGORY_LABEL[s.toolCategory ?? 'other'];
    case 'permission_wait':
      return s.toolName ?? '';
    case 'thinking':
      return s.subagents > 0 ? 'em reunião' : '';
    default:
      return '';
  }
}
