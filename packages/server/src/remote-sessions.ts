import { sessionKey, type AgentKind, type EventMeta, type EventType, type NormalizedEvent, type SessionChanges } from './schema.js';
import type { SessionStore } from './state.js';

export interface RemoteSettings {
  enabled: boolean;
  /** Caminho da CLI do agente (gravado por `agent-office cloud on`). */
  bin: string;
  /** Intervalo entre consultas, em segundos. */
  everySec: number;
}

/** O que dá para saber de uma sessão que roda na nuvem do agente. */
export type RemoteState = 'running' | 'waiting' | 'done' | 'error';

export interface RemoteSession {
  id: string;
  state: RemoteState;
  title?: string;
  url?: string;
  /** Ambiente ou repositório, quando a nuvem informa. */
  project?: string;
  changes?: SessionChanges;
  /** Última atualização, quando a nuvem informa. */
  updatedAt?: number;
}

export interface RemoteProvider {
  agent: AgentKind;
  /** Nome exibido como origem da sessão ("Codex Cloud", "Claude Cloud"). */
  entrypoint: string;
  /** Menor intervalo aceito entre consultas, em segundos. */
  minEverySec: number;
  /** Consulta a nuvem pela CLI do agente. */
  list(bin: string, now: number): Promise<RemoteSession[]>;
}

export interface RemoteStatus {
  enabled: boolean;
  /** Sessões rodando na nuvem agora. */
  running: number;
  lastOkAt: number | null;
  error: string | null;
}

/** A sessão já estava esperando quando a vimos pela primeira vez: aparece, mas não dispara o alerta. */
export const ALREADY_WAITING = 'already_waiting';
/** Passou a esperar o usuário enquanto observávamos. */
export const REQUIRES_ACTION = 'requires_action';

/** Sessões já concluídas só aparecem se terminaram há pouco. */
const RECENT_MS = 10 * 60_000;

export function remoteSessionId(id: string): string {
  return `cloud-${id}`;
}

/**
 * Sessões que rodam na nuvem do agente: não há hooks nem arquivos locais,
 * então o servidor consulta a CLI do próprio agente de tempos em tempos e
 * transforma cada sessão remota em uma sessão do escritório. Opcional e
 * desligado por padrão — é a única fonte que faz uma requisição para fora (à
 * sua conta, pela CLI oficial).
 */
export class RemoteSessionWatcher {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private lastPollAt = 0;
  private lastOkAt: number | null = null;
  private error: string | null = null;
  /** Último estado visto de cada sessão remota que entrou no escritório. */
  private readonly tracked = new Map<string, RemoteState>();
  /** Sessões antigas, já paradas quando as vimos pela primeira vez. */
  private readonly skipped = new Set<string>();

  constructor(
    private readonly store: SessionStore,
    private readonly settings: () => RemoteSettings,
    private readonly provider: RemoteProvider,
    private readonly now: () => number = Date.now,
    private readonly log: (msg: string) => void = () => undefined,
  ) {}

  start(intervalMs = 1000): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): RemoteStatus {
    let running = 0;
    for (const s of this.tracked.values()) if (s === 'running') running++;
    return { enabled: this.active(this.settings()), running, lastOkAt: this.lastOkAt, error: this.error };
  }

  /** Um passo: consulta a nuvem se estiver ligado e já tiver passado o intervalo. */
  async tick(): Promise<boolean> {
    if (this.polling) return false;
    const settings = this.settings();
    if (!this.active(settings)) {
      this.clear('cloud_off');
      return false;
    }
    if (this.now() - this.lastPollAt < Math.max(this.provider.minEverySec, settings.everySec) * 1000) return false;
    this.polling = true;
    this.lastPollAt = this.now();
    const name = this.provider.entrypoint;
    try {
      this.apply(await this.provider.list(settings.bin, this.now()));
      this.lastOkAt = this.now();
      if (this.error) this.log(`${name}: consulta voltou a funcionar`);
      this.error = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== this.error) this.log(`${name}: ${message}`);
      this.error = message;
    } finally {
      this.polling = false;
    }
    return true;
  }

  private active(settings: RemoteSettings): boolean {
    return settings.enabled && settings.bin.length > 0;
  }

  private key(id: string): string {
    return sessionKey(this.provider.agent, remoteSessionId(id));
  }

  /** Desligado: as sessões da nuvem saem do escritório. */
  private clear(reason: string): void {
    for (const id of this.tracked.keys()) this.store.end(this.key(id), this.now(), reason);
    this.tracked.clear();
    this.skipped.clear();
    this.lastPollAt = 0;
    this.lastOkAt = null;
    this.error = null;
  }

  private apply(sessions: RemoteSession[]): void {
    const now = this.now();
    const listed = new Set<string>();
    for (const session of sessions) {
      listed.add(session.id);
      const before = this.tracked.get(session.id);
      const at = Math.min(now, session.updatedAt ?? now);
      const stopped = session.state === 'done' || session.state === 'error';
      if (before === undefined) {
        if (stopped) {
          // Sem data, não dá para saber se parou agora ou há uma semana: fica de fora.
          const recent = session.updatedAt !== undefined && now - session.updatedAt <= RECENT_MS;
          if (!recent) {
            this.skipped.add(session.id);
            continue;
          }
        }
        this.skipped.delete(session.id);
        this.emit(session, 'session_start', at);
        if (session.state === 'running') this.emit(session, 'tool_start', at);
        else if (session.state === 'waiting') this.emit(session, 'waiting_input', at, ALREADY_WAITING);
        else this.finish(session, at);
      } else if (before !== session.state) {
        if (session.state === 'running') {
          // Nova rodada na mesma sessão (um pedido de ajuste, uma resposta sua).
          this.emit(session, 'prompt', now);
          this.emit(session, 'tool_start', now);
        } else if (session.state === 'waiting') {
          this.emit(session, 'waiting_input', now, REQUIRES_ACTION);
        } else if (before === 'running' || before === 'waiting') {
          this.finish(session, now);
        }
      }
      // Título e contagens em dia; enquanto roda ou espera, a sessão não expira por inatividade.
      this.store.apply({
        kind: 'meta',
        agent: this.provider.agent,
        sessionId: remoteSessionId(session.id),
        ts: now,
        meta: { ...this.meta(session), alive: !stopped },
      });
      this.tracked.set(session.id, session.state);
    }
    // Sumiu da listagem (apagada ou arquivada): sai do escritório.
    for (const id of [...this.tracked.keys()]) {
      if (listed.has(id)) continue;
      this.store.end(this.key(id), now, 'cloud_gone');
      this.tracked.delete(id);
    }
  }

  private finish(session: RemoteSession, ts: number): void {
    this.emit(session, session.state === 'error' ? 'error' : 'stop', ts);
  }

  private meta(session: RemoteSession): EventMeta {
    return {
      entrypoint: this.provider.entrypoint,
      remote: true,
      ...(session.title ? { title: session.title } : {}),
      ...(session.url ? { url: session.url } : {}),
      ...(session.changes ? { changes: session.changes } : {}),
    };
  }

  private emit(session: RemoteSession, event: EventType, ts: number, reason?: string): void {
    const ev: NormalizedEvent = {
      agent: this.provider.agent,
      sessionId: remoteSessionId(session.id),
      cwd: '',
      project: session.project ?? this.provider.entrypoint,
      event,
      toolCategory: 'other',
      ts,
      source: 'cloud',
      ...(event === 'tool_start' ? { toolName: this.provider.entrypoint } : {}),
      meta: { ...this.meta(session), ...(reason ? { reason } : {}) },
    };
    this.store.apply(ev);
  }
}
