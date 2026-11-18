/**
 * Schema único do agent-office.
 *
 * Tudo que entra no servidor (hooks, watchers de arquivo, modo demo) é
 * convertido para `NormalizedEvent`. Apenas metadados trafegam aqui: nunca
 * conteúdo de prompts, respostas ou arquivos.
 */

export type AgentKind = 'claude' | 'codex';

export const EVENT_TYPES = [
  'session_start',
  'prompt',
  'tool_start',
  'tool_end',
  'subagent_start',
  'subagent_stop',
  'waiting_input',
  'permission_wait',
  'error',
  'stop',
  'session_end',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const TOOL_CATEGORIES = [
  'read',
  'write',
  'edit',
  'bash',
  'search',
  'web',
  'plan',
  'other',
] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/** De onde o evento veio. */
export type EventSource = 'hook' | 'watcher' | 'cloud' | 'demo' | 'system';

/** Metadados opcionais (nunca conteúdo). */
export interface EventMeta {
  /** Id da chamada de ferramenta, usado para deduplicar hook × watcher. */
  toolUseId?: string;
  pid?: number;
  model?: string;
  /** Origem da sessão: "cli", "claude-desktop", "Codex Desktop"... */
  entrypoint?: string;
  /** Tipo do subagente (Explore, general-purpose...). */
  agentType?: string;
  /** Apelido do subagente (Codex). */
  nickname?: string;
  /** Motivo (fim de sessão, tipo de notificação, interrupção...). */
  reason?: string;
  contextTokens?: number;
  contextWindow?: number;
  /**
   * Assunto da sessão em poucas palavras: o título que o próprio agente dá à
   * sessão/thread, ou a descrição curta da tarefa de um subagente.
   */
  title?: string;
  /**
   * Ferramenta-invólucro que executa outras ferramentas por dentro (o "exec" do
   * code mode do Codex). Quando os hooks já reportam as ferramentas reais da
   * sessão, o invólucro visto pelo watcher é ignorado.
   */
  wrapper?: boolean;
  /** A sessão roda na nuvem do agente (não nesta máquina). */
  remote?: boolean;
  /** Endereço da sessão remota no site do agente. */
  url?: string;
  /** Tamanho da alteração produzida por uma sessão remota. */
  changes?: SessionChanges;
  /** Tokens consumidos por uma resposta do modelo (só números). */
  usage?: TokenUsage;
  /** Id da resposta a que `usage` se refere: o transcript repete a mesma resposta em várias linhas. */
  messageId?: string;
  /** Tokens consumidos pela sessão inteira até aqui (o Codex informa o acumulado). */
  usageTotal?: TokenUsage;
}

/** Contagem de tokens, separada do jeito que os agentes informam. */
export interface TokenUsage {
  /** Entrada nova (fora do cache). */
  input: number;
  /** Saída (inclui raciocínio). */
  output: number;
  /** Entrada lida do cache. */
  cacheRead: number;
  /** Entrada gravada no cache. */
  cacheWrite: number;
}

export interface SessionChanges {
  files: number;
  added: number;
  removed: number;
}

export interface NormalizedEvent {
  agent: AgentKind;
  sessionId: string;
  parentSessionId?: string;
  cwd: string;
  project: string;
  event: EventType;
  toolCategory: ToolCategory;
  ts: number;
  /** Nome da ferramenta (ex.: "Bash", "apply_patch"). Metadado, não conteúdo. */
  toolName?: string;
  source: EventSource;
  meta?: EventMeta;
}

/** Atualização só de metadados (contexto, pid, processo vivo). Não é um evento. */
export interface MetaUpdate {
  kind: 'meta';
  agent: AgentKind;
  sessionId: string;
  ts: number;
  cwd?: string;
  meta: EventMeta & { alive?: boolean };
}

export type Ingest = NormalizedEvent | MetaUpdate;

export type SessionStatus =
  | 'starting'
  | 'thinking'
  | 'working'
  | 'waiting_input'
  | 'permission_wait'
  | 'error'
  | 'done'
  | 'idle'
  | 'ended';

export interface TimelineEntry {
  ts: number;
  event: EventType;
  toolCategory: ToolCategory;
  toolName?: string;
  source: EventSource;
}

export interface SessionState {
  /** `${agent}:${sessionId}` */
  key: string;
  agent: AgentKind;
  sessionId: string;
  parentKey?: string;
  parentSessionId?: string;
  /** Nome amigável do personagem. */
  label: string;
  /** Assunto da sessão em poucas palavras (título da sessão ou tarefa do subagente). */
  title?: string;
  cwd: string;
  project: string;
  status: SessionStatus;
  statusSince: number;
  /** Categoria da ferramenta em uso (ou aguardando permissão). */
  toolCategory: ToolCategory | null;
  toolName: string | null;
  startedAt: number;
  lastActivityAt: number;
  endedAt?: number;
  /**
   * Por que a sessão está esperando o usuário (ex.: "permission_prompt",
   * "idle_prompt", "elicitation_dialog"). Só existe em waiting_input/permission_wait.
   */
  attentionReason?: string;
  /** Momento do último erro de ferramenta (para animação transitória). */
  lastErrorAt?: number;
  /** Subagentes ativos. */
  subagents: number;
  context?: { tokens: number; window: number; pct: number };
  model?: string;
  entrypoint?: string;
  agentType?: string;
  pid?: number;
  /** Processo confirmado vivo (quando o agente expõe essa informação). */
  alive?: boolean;
  /** Sessão na nuvem do agente: sem diretório, processo ou ferramentas locais. */
  remote?: boolean;
  /** Onde abrir a sessão remota no navegador. */
  url?: string;
  changes?: SessionChanges;
  /**
   * Nome da máquina de origem, quando a sessão foi espelhada do agent-office
   * de outro computador. Ausente = roda nesta máquina (ou na nuvem).
   */
  machine?: string;
  counts: { prompts: number; tools: number; errors: number };
  timeline: TimelineEntry[];
  sources: { hook: boolean; watcher: boolean };
}

/** Sessões que pedem a atenção do usuário. */
export function needsAttention(status: SessionStatus): boolean {
  return status === 'waiting_input' || status === 'permission_wait';
}

/**
 * A sessão está parada esperando uma DECISÃO do usuário: um pedido de permissão
 * ou uma pergunta. Um turno que simplesmente terminou e está ocioso no prompt
 * ("idle_prompt") não conta.
 */
export function needsDecision(s: Pick<SessionState, 'status' | 'attentionReason'>): boolean {
  if (s.status === 'permission_wait') return true;
  // "already_waiting": sessão em nuvem que já esperava quando a vimos — sem data, pode ser antiga.
  return s.status === 'waiting_input' && s.attentionReason !== 'idle_prompt' && s.attentionReason !== 'already_waiting';
}

export function sessionKey(agent: AgentKind, sessionId: string): string {
  return `${agent}:${sessionId}`;
}

export interface ServerConfigInfo {
  idleAfterMs: number;
  endAfterMs: number;
}

export type ServerMessage =
  | {
      type: 'hello';
      version: string;
      serverTime: number;
      demo: boolean;
      config: ServerConfigInfo;
      sessions: SessionState[];
    }
  | { type: 'session'; session: SessionState }
  | { type: 'event'; key: string; event: NormalizedEvent }
  | { type: 'remove'; key: string }
  | { type: 'usage'; usage: UsageResponse };

export interface StatsResponse {
  since: number;
  today: {
    events: number;
    sessions: number;
    prompts: number;
    tools: number;
    errors: number;
    byAgent: Record<string, number>;
    byCategory: Record<string, number>;
  };
  allTime: { events: number; sessions: number };
  /** Eventos por hora nas últimas 24h (mais antigo → mais recente). */
  hourly: { hour: number; events: number }[];
}

/** Totais acumulados de um recorte (tudo, hoje, um agente...). */
export interface UsageTotals {
  tokens: TokenUsage & { total: number };
  prompts: number;
  /** Chamadas de ferramenta. */
  tools: number;
  errors: number;
  /** Sessões principais (subagentes contam à parte). */
  sessions: number;
  subagents: number;
  /** Tempo em que as sessões principais estiveram trabalhando (ms, somado entre sessões). */
  activeMs: number;
  /** O mesmo para os subagentes. */
  subagentActiveMs: number;
}

export interface UsageDay {
  /** Meia-noite local do dia (ms). */
  day: number;
  /** Tokens por agente. */
  claude: number;
  codex: number;
  prompts: number;
  activeMs: number;
}

export interface UsageRank {
  name: string;
  tokens: number;
}

/**
 * Painel de dados: o acumulado de todas as sessões desta máquina, lido dos
 * transcripts locais. Só números, nomes de modelo e nomes de projeto.
 */
export interface UsageResponse {
  /** Primeiro dia com dados (meia-noite local) ou null se ainda não há nada. */
  since: number | null;
  updatedAt: number;
  allTime: UsageTotals;
  today: UsageTotals;
  /** Últimos 7 dias, hoje incluído. */
  week: UsageTotals;
  byAgent: Record<AgentKind, UsageTotals>;
  /** Últimos 14 dias, do mais antigo para hoje. */
  days: UsageDay[];
  toolsByCategory: Record<ToolCategory, number>;
  /** Modelos e projetos que mais consumiram tokens. */
  models: UsageRank[];
  projects: UsageRank[];
  /** Dias com alguma atividade. */
  activeDays: number;
  busiestDay: { day: number; tokens: number } | null;
  /** Leitura do histórico: arquivos na fila e já lidos nesta rodada. */
  scan: { pending: number; done: number; scanning: boolean };
}

export interface HealthResponse {
  ok: true;
  name: 'agent-office';
  version: string;
  host: string;
  port: number;
  pid: number;
  uptimeMs: number;
  demo: boolean;
  sessions: number;
  clients: number;
  events: { total: number; hook: number; watcher: number };
  lastHookAt: { claude: number | null; codex: number | null };
  watcher: { enabled: boolean; claudeFiles: number; codexFiles: number; tracked: number };
  webBuilt: boolean;
  /** Alerta sonoro: ligado? quantas sessões aguardam decisão agora? */
  voiceAlert: { enabled: boolean; pending: number };
  /** Sessões na nuvem de cada agente: ligado? quantas rodando? última consulta e erro. */
  codexCloud: RemoteSourceHealth;
  claudeCloud: RemoteSourceHealth;
  /** Outros computadores cujas sessões este escritório espelha. */
  peers: PeerHealth[];
}

export interface PeerHealth {
  name: string;
  connected: boolean;
  sessions: number;
  lastOkAt: number | null;
  error: string | null;
}

export interface RemoteSourceHealth {
  enabled: boolean;
  running: number;
  lastOkAt: number | null;
  error: string | null;
}

export interface FocusResponse {
  ok: boolean;
  detail: string;
}
