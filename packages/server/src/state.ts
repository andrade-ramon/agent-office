import { EventEmitter } from 'node:events';
import {
  sessionKey,
  type AgentKind,
  type EventSource,
  type Ingest,
  type MetaUpdate,
  type NormalizedEvent,
  type SessionState,
  type SessionStatus,
  type ToolCategory,
} from './schema.js';
import { cleanTitle, hashString, projectFromCwd } from './util.js';

export interface StoreOptions {
  /** Sem eventos por este tempo → "idle". */
  idleAfterMs: number;
  /** Sem eventos por este tempo (e sem processo vivo conhecido) → "encerrada". */
  endAfterMs: number;
  /** Subagente parado por este tempo → encerrado. */
  childEndAfterMs: number;
  /** Sessão encerrada é esquecida depois deste tempo. */
  purgeAfterMs: number;
  timelineSize: number;
  /** Janela para agrupar atualizações de sessão antes de emitir. */
  flushMs: number;
  /** Guarda o assunto (título) das sessões. Desligue para metadados estritos. */
  titles: boolean;
}

export const DEFAULT_STORE_OPTIONS: StoreOptions = {
  idleAfterMs: 5 * 60_000,
  endAfterMs: 30 * 60_000,
  childEndAfterMs: 90_000,
  purgeAfterMs: 90_000,
  timelineSize: 40,
  flushMs: 25,
  titles: true,
};

/** Evento mais antigo que o último estado aplicado por mais que isto é "atrasado". */
const LATE_MS = 1500;
/** Mesmo evento vindo de outra fonte dentro desta janela é duplicata. */
const DEDUP_WINDOW_MS = 5000;
const MAX_SEEN_IDS = 400;

const NAMES = [
  'Ada', 'Bento', 'Cora', 'Davi', 'Elis', 'Fausto', 'Gaia', 'Heitor', 'Iara', 'Jorge', 'Kira', 'Lino',
  'Maya', 'Nilo', 'Olga', 'Pedro', 'Quim', 'Rosa', 'Sol', 'Tito', 'Uma', 'Vasco', 'Wanda', 'Xavi',
  'Yara', 'Zeca', 'Alma', 'Caio', 'Dora', 'Enzo', 'Flor', 'Gil', 'Inês', 'Joca', 'Lia', 'Mino',
  'Nina', 'Otto', 'Pilar', 'Rui',
];

interface OpenTool {
  name?: string;
  category: ToolCategory;
  ts: number;
  wrapper?: boolean;
}

interface Internal {
  state: SessionState;
  openTools: Map<string, OpenTool>;
  seenStart: Set<string>;
  seenEnd: Set<string>;
  lastByType: Map<string, { ts: number; source: EventSource }>;
  lastStateTs: number;
  anon: number;
  /** A sessão já reportou ferramentas por hook (mais precisas que o invólucro do watcher). */
  hookTools: boolean;
}

export interface ApplyOptions {
  /** Reprocessamento de histórico: atualiza o estado sem emitir 'event'. */
  replay?: boolean;
}

export interface SessionStoreEvents {
  session: [state: SessionState];
  event: [key: string, event: NormalizedEvent, state: SessionState];
  remove: [key: string];
}

function remember(set: Set<string>, id: string): void {
  set.add(id);
  if (set.size > MAX_SEEN_IDS) {
    const first = set.values().next().value;
    if (first !== undefined) set.delete(first);
  }
}

/**
 * Estado em memória de todas as sessões. Recebe eventos normalizados de
 * qualquer fonte, deduplica hook × watcher e mantém a máquina de estados.
 */
export class SessionStore extends EventEmitter<SessionStoreEvents> {
  readonly options: StoreOptions;
  private readonly sessions = new Map<string, Internal>();
  private readonly dirtyKeys = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(options: Partial<StoreOptions> = {}) {
    super();
    this.options = { ...DEFAULT_STORE_OPTIONS, ...options };
  }

  list(): SessionState[] {
    return [...this.sessions.values()].map((it) => this.snapshot(it));
  }

  get(key: string): SessionState | undefined {
    const it = this.sessions.get(key);
    return it ? this.snapshot(it) : undefined;
  }

  has(key: string): boolean {
    return this.sessions.has(key);
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Aplica um evento (ou atualização de metadados). Retorna true se mudou algo. */
  apply(item: Ingest, opts: ApplyOptions = {}): boolean {
    if ('kind' in item) return this.applyMeta(item);
    const ev = item;
    if (!ev.sessionId) return false;
    const key = sessionKey(ev.agent, ev.sessionId);
    let it = this.sessions.get(key);
    const ending = ev.event === 'session_end' || ev.event === 'subagent_stop';
    if (!it) {
      if (ending) return false;
      it = this.create(key, ev);
    }
    const s = it.state;
    this.mergeFromEvent(it, ev);

    if (ev.source === 'hook' && ev.event === 'tool_start' && !it.hookTools) {
      it.hookTools = true;
      for (const [k, t] of it.openTools) if (t.wrapper) it.openTools.delete(k);
    }
    if (it.hookTools && ev.source !== 'hook' && ev.meta?.wrapper) {
      // Os hooks já mostram as ferramentas reais; o invólucro só duplicaria.
      this.markDirty(key);
      return false;
    }

    if (this.isDuplicate(it, ev)) {
      this.markDirty(key);
      return false;
    }

    const wasEnded = s.status === 'ended';
    // Uma sessão encerrada só revive com sinal de atividade nova; um "stop" ou
    // "tool_end" que chega depois do fim (outra fonte, atrasada) não a ressuscita.
    const late = ev.ts < it.lastStateTs - LATE_MS || (wasEnded && !REVIVES.has(ev.event));
    const id = ev.meta?.toolUseId;

    switch (ev.event) {
      case 'prompt':
        s.counts.prompts++;
        break;
      case 'tool_start':
        s.counts.tools++;
        break;
      case 'error':
        s.counts.errors++;
        break;
      default:
        break;
    }

    if (!late) {
      switch (ev.event) {
        case 'session_start':
          if (wasEnded || s.status === 'starting') this.setStatus(it, 'starting', ev.ts);
          break;
        case 'subagent_start':
          if (wasEnded || s.status === 'starting') this.setStatus(it, 'thinking', ev.ts);
          break;
        case 'prompt':
          it.openTools.clear();
          this.setStatus(it, 'thinking', ev.ts);
          break;
        case 'tool_start': {
          const alreadyEnded = id ? it.seenEnd.has(id) : false;
          if (!alreadyEnded) {
            it.openTools.set(id ?? `anon-${++it.anon}`, {
              name: ev.toolName,
              category: ev.toolCategory,
              ts: ev.ts,
              ...(ev.meta?.wrapper ? { wrapper: true } : {}),
            });
          }
          this.refreshWorking(it, ev.ts);
          break;
        }
        case 'tool_end':
          this.closeTool(it, ev);
          this.refreshWorking(it, ev.ts);
          break;
        case 'error':
          if (id || ev.toolName) {
            // Erro de ferramenta: transitório, o agente continua trabalhando.
            this.closeTool(it, ev);
            s.lastErrorAt = ev.ts;
            this.refreshWorking(it, ev.ts);
          } else {
            it.openTools.clear();
            s.lastErrorAt = ev.ts;
            this.setStatus(it, 'error', ev.ts);
          }
          break;
        case 'permission_wait':
          this.setStatus(it, 'permission_wait', ev.ts, ev.toolName ? ev.toolCategory : s.toolCategory, ev.toolName ?? s.toolName);
          if (ev.meta?.reason) s.attentionReason = ev.meta.reason;
          break;
        case 'waiting_input':
          this.setStatus(it, 'waiting_input', ev.ts);
          if (ev.meta?.reason) s.attentionReason = ev.meta.reason;
          break;
        case 'stop':
          it.openTools.clear();
          this.setStatus(it, 'done', ev.ts);
          break;
        case 'session_end':
        case 'subagent_stop':
          this.markEnded(it, ev.ts);
          break;
      }
      it.lastStateTs = Math.max(it.lastStateTs, ev.ts);
      if (wasEnded && s.status !== 'ended') {
        delete s.endedAt;
        if (s.parentKey) this.markDirty(s.parentKey);
      }
    }

    s.lastActivityAt = Math.max(s.lastActivityAt, ev.ts);
    s.timeline.push({
      ts: ev.ts,
      event: ev.event,
      toolCategory: ev.toolCategory,
      ...(ev.toolName ? { toolName: ev.toolName } : {}),
      source: ev.source,
    });
    if (s.timeline.length > this.options.timelineSize) {
      s.timeline.splice(0, s.timeline.length - this.options.timelineSize);
    }

    this.markDirty(key);
    if (!opts.replay) this.emit('event', key, ev, this.snapshot(it));
    return true;
  }

  /** Encerra uma sessão (processo saiu, arquivo arquivado, timeout). */
  end(key: string, ts: number, reason: string, opts: ApplyOptions = {}): void {
    const it = this.sessions.get(key);
    if (!it || it.state.status === 'ended') return;
    const s = it.state;
    this.apply(
      {
        agent: s.agent,
        sessionId: s.sessionId,
        ...(s.parentSessionId ? { parentSessionId: s.parentSessionId } : {}),
        cwd: s.cwd,
        project: s.project,
        event: s.parentKey ? 'subagent_stop' : 'session_end',
        toolCategory: 'other',
        ts: Math.max(ts, it.lastStateTs),
        source: 'system',
        meta: { reason },
      },
      opts,
    );
  }

  /**
   * Sai de "aguardando o usuário" e volta ao trabalho (permissão concedida ou
   * pergunta respondida) quando a fonte sabe disso sem um evento próprio.
   */
  resume(key: string, ts: number): void {
    const it = this.sessions.get(key);
    if (!it) return;
    const s = it.state;
    if (s.status !== 'permission_wait' && s.status !== 'waiting_input') return;
    this.refreshWorking(it, ts);
    s.lastActivityAt = Math.max(s.lastActivityAt, ts);
    it.lastStateTs = Math.max(it.lastStateTs, ts);
    this.markDirty(key);
  }

  /** Aplica os timeouts de inatividade. Chamado periodicamente. */
  tick(now: number = Date.now()): void {
    const { idleAfterMs, endAfterMs, childEndAfterMs, purgeAfterMs } = this.options;
    for (const [key, it] of [...this.sessions]) {
      const s = it.state;
      if (s.status === 'ended') {
        if (now - (s.endedAt ?? s.lastActivityAt) > purgeAfterMs) this.remove(key);
        continue;
      }
      const quiet = now - s.lastActivityAt;
      if (s.parentKey) {
        const parent = this.sessions.get(s.parentKey);
        if (parent && parent.state.status === 'ended') {
          this.end(key, now, 'parent_ended');
          continue;
        }
        // Só quem concluiu a tarefa sai; um subagente quieto pode estar gerando uma resposta longa.
        if (s.status === 'done' && now - s.statusSince > childEndAfterMs) {
          this.end(key, now, 'subagent_finished');
          continue;
        }
      }
      if (!s.alive && quiet > endAfterMs) {
        this.end(key, now, 'timeout');
        continue;
      }
      if (quiet > idleAfterMs && IDLE_FROM.has(s.status)) {
        it.openTools.clear();
        this.setStatus(it, 'idle', now);
        this.markDirty(key);
      }
    }
  }

  remove(key: string): void {
    if (!this.sessions.delete(key)) return;
    this.dirtyKeys.delete(key);
    this.emit('remove', key);
  }

  /** Emite imediatamente as atualizações pendentes. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const keys = [...this.dirtyKeys];
    this.dirtyKeys.clear();
    for (const key of keys) {
      const it = this.sessions.get(key);
      if (it) this.emit('session', this.snapshot(it));
    }
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.dirtyKeys.clear();
    this.removeAllListeners();
  }

  // ───────────────────────────── internos ─────────────────────────────

  private create(key: string, ev: NormalizedEvent): Internal {
    const child = Boolean(ev.parentSessionId);
    const state: SessionState = {
      key,
      agent: ev.agent,
      sessionId: ev.sessionId,
      label: child ? 'Subagente' : this.pickName(key),
      cwd: ev.cwd,
      project: ev.project || projectFromCwd(ev.cwd),
      status: child ? 'thinking' : 'starting',
      statusSince: ev.ts,
      toolCategory: null,
      toolName: null,
      startedAt: ev.ts,
      lastActivityAt: ev.ts,
      subagents: 0,
      counts: { prompts: 0, tools: 0, errors: 0 },
      timeline: [],
      sources: { hook: false, watcher: false },
    };
    const it: Internal = {
      state,
      openTools: new Map(),
      seenStart: new Set(),
      seenEnd: new Set(),
      lastByType: new Map(),
      lastStateTs: 0,
      anon: 0,
      hookTools: false,
    };
    this.sessions.set(key, it);
    return it;
  }

  /** Nome estável por sessão, evitando repetir nomes já em uso no escritório. */
  private pickName(key: string): string {
    const used = new Set<string>();
    for (const it of this.sessions.values()) used.add(it.state.label);
    const start = hashString(key) % NAMES.length;
    for (let i = 0; i < NAMES.length; i++) {
      const name = NAMES[(start + i) % NAMES.length]!;
      if (!used.has(name)) return name;
    }
    for (let n = 2; ; n++) {
      const name = `${NAMES[start]!} ${n}`;
      if (!used.has(name)) return name;
    }
  }

  private mergeFromEvent(it: Internal, ev: NormalizedEvent): void {
    const s = it.state;
    if (ev.cwd && ev.cwd !== s.cwd) {
      // Sessões-filhas herdam o cwd do pai quando o evento não traz um.
      if (!s.cwd || ev.ts >= it.lastStateTs) {
        s.cwd = ev.cwd;
        s.project = ev.project || projectFromCwd(ev.cwd);
      }
    }
    if (ev.parentSessionId && !s.parentKey) {
      s.parentSessionId = ev.parentSessionId;
      s.parentKey = sessionKey(ev.agent, ev.parentSessionId);
      if (NAMES.includes(s.label.replace(/ \d+$/, ''))) s.label = 'Subagente';
      this.markDirty(s.parentKey);
    }
    if (ev.source === 'hook') s.sources.hook = true;
    if (ev.source === 'watcher') s.sources.watcher = true;
    if (ev.ts < s.startedAt) s.startedAt = ev.ts;
    if (ev.meta) this.mergeMeta(it, ev.agent, ev.meta);
  }

  private mergeMeta(it: Internal, agent: AgentKind, meta: MetaUpdate['meta']): void {
    const s = it.state;
    if (meta.pid) s.pid = meta.pid;
    if (meta.model) s.model = meta.model;
    if (meta.entrypoint) s.entrypoint = meta.entrypoint;
    if (meta.agentType) {
      s.agentType = meta.agentType;
      if (s.parentKey && s.label === 'Subagente') s.label = meta.agentType;
    }
    if (meta.nickname) s.label = meta.nickname;
    if (this.options.titles) {
      const title = cleanTitle(meta.title);
      if (title) s.title = title;
    }
    if (meta.alive !== undefined) s.alive = meta.alive;
    if (meta.contextTokens || meta.contextWindow) {
      const tokens = meta.contextTokens ?? s.context?.tokens ?? 0;
      let window = meta.contextWindow ?? s.context?.window ?? defaultWindow(agent);
      if (!meta.contextWindow && tokens > window) window = 1_000_000;
      s.context = { tokens, window, pct: window > 0 ? Math.min(1, tokens / window) : 0 };
    }
  }

  private applyMeta(update: MetaUpdate): boolean {
    const key = sessionKey(update.agent, update.sessionId);
    const it = this.sessions.get(key);
    if (!it) return false;
    if (update.cwd && !it.state.cwd) {
      it.state.cwd = update.cwd;
      it.state.project = projectFromCwd(update.cwd);
    }
    this.mergeMeta(it, update.agent, update.meta);
    this.markDirty(key);
    return true;
  }

  private isDuplicate(it: Internal, ev: NormalizedEvent): boolean {
    const id = ev.meta?.toolUseId;
    if (id && ev.event === 'tool_start') {
      if (it.seenStart.has(id)) return true;
      remember(it.seenStart, id);
      return false;
    }
    if (id && (ev.event === 'tool_end' || ev.event === 'error')) {
      if (it.seenEnd.has(id)) return true;
      remember(it.seenEnd, id);
      return false;
    }
    const sig = ev.toolName ? `${ev.event}:${ev.toolName}` : ev.event;
    const last = it.lastByType.get(sig);
    if (last && last.source !== ev.source && Math.abs(last.ts - ev.ts) < DEDUP_WINDOW_MS) return true;
    it.lastByType.set(sig, { ts: ev.ts, source: ev.source });
    return false;
  }

  private closeTool(it: Internal, ev: NormalizedEvent): void {
    const id = ev.meta?.toolUseId;
    if (id) {
      it.openTools.delete(id);
      return;
    }
    // Sem id: fecha a mais recente com o mesmo nome; sem nome, a mais recente.
    let match: string | undefined;
    let latest: string | undefined;
    for (const [k, t] of it.openTools) {
      latest = k;
      if (ev.toolName && t.name === ev.toolName) match = k;
    }
    const target = ev.toolName ? match : latest;
    if (target) it.openTools.delete(target);
  }

  /** Recalcula working/thinking a partir das ferramentas abertas. */
  private refreshWorking(it: Internal, ts: number): void {
    let latest: OpenTool | undefined;
    for (const t of it.openTools.values()) latest = t;
    if (latest) this.setStatus(it, 'working', ts, latest.category, latest.name ?? null);
    else this.setStatus(it, 'thinking', ts);
  }

  private setStatus(
    it: Internal,
    status: SessionStatus,
    ts: number,
    category: ToolCategory | null = null,
    toolName: string | null = null,
  ): void {
    const s = it.state;
    if (s.status !== status) {
      s.status = status;
      s.statusSince = ts;
      delete s.attentionReason;
    }
    s.toolCategory = category;
    s.toolName = toolName;
  }

  private markEnded(it: Internal, ts: number): void {
    const s = it.state;
    it.openTools.clear();
    this.setStatus(it, 'ended', ts);
    s.endedAt = ts;
    s.alive = false;
    if (s.parentKey) this.markDirty(s.parentKey);
  }

  private activeChildren(key: string): number {
    let n = 0;
    for (const it of this.sessions.values()) {
      if (it.state.parentKey === key && it.state.status !== 'ended') n++;
    }
    return n;
  }

  private snapshot(it: Internal): SessionState {
    const s = it.state;
    return {
      ...s,
      subagents: this.activeChildren(s.key),
      counts: { ...s.counts },
      sources: { ...s.sources },
      timeline: s.timeline.slice(),
      ...(s.context ? { context: { ...s.context } } : {}),
    };
  }

  private markDirty(key: string): void {
    if (!this.sessions.has(key)) return;
    this.dirtyKeys.add(key);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.options.flushMs);
    this.flushTimer.unref?.();
  }
}

const IDLE_FROM = new Set<SessionStatus>(['starting', 'thinking', 'done', 'error']);
const REVIVES = new Set<NormalizedEvent['event']>([
  'session_start',
  'subagent_start',
  'prompt',
  'tool_start',
  'permission_wait',
  'waiting_input',
]);

function defaultWindow(agent: AgentKind): number {
  return agent === 'claude' ? 200_000 : 272_000;
}

