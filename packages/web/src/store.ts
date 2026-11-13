import type {
  FocusResponse,
  NormalizedEvent,
  ServerMessage,
  SessionState,
  StatsResponse,
} from '@agent-office/server/schema';

/**
 * Estado do app: conexão WebSocket com reconexão automática, sessões e
 * estatísticas. Compatível com `useSyncExternalStore`.
 */

export type ConnState = 'connecting' | 'open' | 'reconnecting';

export interface StoreState {
  conn: ConnState;
  /** Já recebeu ao menos um `hello`. */
  ready: boolean;
  demo: boolean;
  version: string | null;
  sessions: ReadonlyMap<string, SessionState>;
  stats: StatsResponse | null;
  /** Diferença entre o relógio do servidor e o local (ms). */
  clockOffset: number;
  /** Quantas vezes já reconectou (para depuração). */
  reconnects: number;
}

export type AttentionKind = 'waiting_input' | 'permission_wait' | 'done';

export interface StoreEvents {
  hello(sessions: SessionState[]): void;
  session(session: SessionState): void;
  remove(key: string): void;
  event(key: string, event: NormalizedEvent): void;
  /** Uma sessão passou a pedir atenção (ou terminou o turno). */
  attention(session: SessionState, kind: AttentionKind): void;
}

type Listener = () => void;

const STATS_EVERY_MS = 30_000;
const PING_EVERY_MS = 20_000;
const STALE_AFTER_MS = 55_000;

export class OfficeStore {
  private state: StoreState = {
    conn: 'connecting',
    ready: false,
    demo: false,
    version: null,
    sessions: new Map(),
    stats: null,
    clockOffset: 0,
    reconnects: 0,
  };
  private readonly listeners = new Set<Listener>();
  private readonly handlers = new Set<Partial<StoreEvents>>();
  private ws: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: number | null = null;
  private pingTimer: number | null = null;
  private statsTimer: number | null = null;
  private notifyTimer: number | null = null;
  private lastMessageAt = 0;
  private disposed = false;
  private started = false;

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getState = (): StoreState => this.state;

  /** Recebe as mensagens do servidor em ordem (usado pela cena). */
  on(handlers: Partial<StoreEvents>): () => void {
    this.handlers.add(handlers);
    return () => this.handlers.delete(handlers);
  }

  /** Hora atual no relógio do servidor. */
  now(): number {
    return Date.now() + this.state.clockOffset;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.disposed = false;
    this.open();
    this.statsTimer = window.setInterval(() => void this.refreshStats(), STATS_EVERY_MS);
    this.pingTimer = window.setInterval(() => this.heartbeat(), PING_EVERY_MS);
    window.addEventListener('online', this.onOnline);
  }

  dispose(): void {
    this.disposed = true;
    this.started = false;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    if (this.statsTimer !== null) window.clearInterval(this.statsTimer);
    if (this.notifyTimer !== null) window.clearTimeout(this.notifyTimer);
    this.retryTimer = this.pingTimer = this.statsTimer = this.notifyTimer = null;
    window.removeEventListener('online', this.onOnline);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = ws.onerror = ws.onmessage = ws.onopen = null;
      ws.close();
    }
  }

  async focusWindow(key: string): Promise<FocusResponse> {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(key)}/focus`, { method: 'POST' });
      const data = (await res.json()) as Partial<FocusResponse>;
      return { ok: Boolean(data.ok), detail: typeof data.detail === 'string' ? data.detail : 'Sem resposta do servidor.' };
    } catch {
      return { ok: false, detail: 'Não foi possível falar com o servidor.' };
    }
  }

  async refreshStats(): Promise<void> {
    if (this.disposed || this.state.conn !== 'open') return;
    try {
      const res = await fetch('/api/stats');
      if (!res.ok) return;
      const stats = (await res.json()) as StatsResponse;
      if (stats && typeof stats === 'object' && stats.today) this.set({ stats });
    } catch {
      /* servidor fora do ar: a reconexão do WebSocket cuida disso */
    }
  }

  // ───────────────────────── interno ─────────────────────────

  private readonly onOnline = (): void => {
    if (this.state.conn !== 'open') this.reconnectNow();
  };

  private set(patch: Partial<StoreState>): void {
    this.state = { ...this.state, ...patch };
    if (this.notifyTimer !== null) return;
    // Agrupa rajadas de mensagens em uma única renderização.
    this.notifyTimer = window.setTimeout(() => {
      this.notifyTimer = null;
      for (const l of [...this.listeners]) l();
    }, 40);
  }

  private emit<K extends keyof StoreEvents>(name: K, ...args: Parameters<StoreEvents[K]>): void {
    for (const h of [...this.handlers]) {
      const fn = h[name] as ((...a: Parameters<StoreEvents[K]>) => void) | undefined;
      if (!fn) continue;
      try {
        fn(...args);
      } catch (err) {
        console.error('[agent-office] erro em ouvinte', err);
      }
    }
  }

  private open(): void {
    if (this.disposed) return;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.lastMessageAt = Date.now();
    };
    ws.onmessage = (e) => {
      this.lastMessageAt = Date.now();
      if (typeof e.data !== 'string') return;
      let msg: ServerMessage | { type: 'pong' };
      try {
        msg = JSON.parse(e.data) as ServerMessage;
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* já fechado */
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (this.disposed) return;
    if (this.state.conn !== 'reconnecting') this.set({ conn: 'reconnecting' });
    const delay = Math.min(8000, 500 * 1.8 ** this.attempt) + Math.random() * 250;
    this.attempt++;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }

  private reconnectNow(): void {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    this.open();
  }

  private heartbeat(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastMessageAt > STALE_AFTER_MS) {
      // Conexão muda: força a reconexão.
      ws.close();
      return;
    }
    try {
      ws.send('{"type":"ping"}');
    } catch {
      /* fecha sozinho */
    }
  }

  private handle(msg: ServerMessage | { type: 'pong' }): void {
    switch (msg.type) {
      case 'hello': {
        const sessions = new Map<string, SessionState>();
        for (const s of msg.sessions) sessions.set(s.key, s);
        const reconnects = this.state.ready ? this.state.reconnects + 1 : this.state.reconnects;
        this.attempt = 0;
        this.set({
          conn: 'open',
          ready: true,
          demo: msg.demo,
          version: msg.version,
          sessions,
          clockOffset: msg.serverTime - Date.now(),
          reconnects,
        });
        this.emit('hello', msg.sessions);
        void this.refreshStats();
        break;
      }
      case 'session': {
        const prev = this.state.sessions.get(msg.session.key);
        const sessions = new Map(this.state.sessions);
        sessions.set(msg.session.key, msg.session);
        this.set({ sessions });
        this.emit('session', msg.session);
        const status = msg.session.status;
        if (prev?.status !== status && (status === 'waiting_input' || status === 'permission_wait' || status === 'done')) {
          this.emit('attention', msg.session, status);
        }
        break;
      }
      case 'remove': {
        if (this.state.sessions.has(msg.key)) {
          const sessions = new Map(this.state.sessions);
          sessions.delete(msg.key);
          this.set({ sessions });
        }
        this.emit('remove', msg.key);
        break;
      }
      case 'event':
        this.emit('event', msg.key, msg.event);
        break;
      default:
        break;
    }
  }
}
