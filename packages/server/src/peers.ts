import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import WebSocket from 'ws';
import type { PeerConfig } from './config.js';
import {
  EVENT_TYPES,
  sessionKey,
  TOOL_CATEGORIES,
  type AgentKind,
  type EventSource,
  type EventType,
  type PeerHealth,
  type SessionState,
  type SessionStatus,
  type TimelineEntry,
  type ToolCategory,
} from './schema.js';
import type { SessionStore } from './state.js';
import { cleanTitle, isObj, num, str } from './util.js';

const STATUSES: ReadonlySet<string> = new Set<SessionStatus>([
  'starting',
  'thinking',
  'working',
  'waiting_input',
  'permission_wait',
  'error',
  'done',
  'idle',
  'ended',
]);
const SOURCES: ReadonlySet<string> = new Set<EventSource>(['hook', 'watcher', 'cloud', 'demo', 'system']);
const CATEGORIES: ReadonlySet<string> = new Set(TOOL_CATEGORIES);
const EVENTS: ReadonlySet<string> = new Set(EVENT_TYPES);

function text(v: unknown, max: number): string | undefined {
  const s = str(v);
  return s ? s.slice(0, max) : undefined;
}

function count(v: unknown): number {
  const n = num(v);
  return n !== undefined && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Converte o que outro escritório enviou em uma sessão espelhada. Nada é
 * aceito como veio: cada campo é conferido e as chaves são recalculadas aqui.
 * `offsetMs` corrige a diferença entre os relógios das duas máquinas.
 */
export function mirrorSnapshot(raw: unknown, machine: string, offsetMs = 0): SessionState | null {
  if (!isObj(raw)) return null;
  const agent: AgentKind | null = raw.agent === 'claude' || raw.agent === 'codex' ? raw.agent : null;
  const sessionId = text(raw.sessionId, 200);
  const status = str(raw.status);
  if (!agent || !sessionId || !status || !STATUSES.has(status)) return null;
  const at = (v: unknown, fallback: number): number => (num(v) ?? fallback) + offsetMs;
  const now = Date.now();
  const startedAt = at(raw.startedAt, now - offsetMs);
  const parentSessionId = text(raw.parentSessionId, 200);
  const toolCategory = str(raw.toolCategory);
  const title = cleanTitle(raw.title);
  const model = text(raw.model, 100);
  const entrypoint = text(raw.entrypoint, 100);
  const agentType = text(raw.agentType, 100);
  const attentionReason = text(raw.attentionReason, 60);
  const url = str(raw.url);
  const origin = text(raw.machine, 40);
  const counts = isObj(raw.counts) ? raw.counts : {};
  const sources = isObj(raw.sources) ? raw.sources : {};
  const context = isObj(raw.context) ? raw.context : null;
  const changes = isObj(raw.changes) ? raw.changes : null;
  const timeline: TimelineEntry[] = [];
  for (const item of Array.isArray(raw.timeline) ? raw.timeline.slice(-40) : []) {
    if (!isObj(item)) continue;
    const event = str(item.event);
    const category = str(item.toolCategory);
    const source = str(item.source);
    if (!event || !EVENTS.has(event)) continue;
    const toolName = text(item.toolName, 120);
    timeline.push({
      ts: at(item.ts, now - offsetMs),
      event: event as EventType,
      toolCategory: (category && CATEGORIES.has(category) ? category : 'other') as ToolCategory,
      ...(toolName ? { toolName } : {}),
      source: (source && SOURCES.has(source) ? source : 'system') as EventSource,
    });
  }
  return {
    key: sessionKey(agent, sessionId),
    agent,
    sessionId,
    ...(parentSessionId ? { parentSessionId, parentKey: sessionKey(agent, parentSessionId) } : {}),
    label: text(raw.label, 60) ?? 'Sessão',
    ...(title ? { title } : {}),
    cwd: text(raw.cwd, 1000) ?? '',
    project: text(raw.project, 200) ?? '',
    status: status as SessionStatus,
    statusSince: at(raw.statusSince, startedAt - offsetMs),
    toolCategory: toolCategory && CATEGORIES.has(toolCategory) ? (toolCategory as ToolCategory) : null,
    toolName: text(raw.toolName, 120) ?? null,
    startedAt,
    lastActivityAt: at(raw.lastActivityAt, startedAt - offsetMs),
    ...(num(raw.endedAt) !== undefined ? { endedAt: at(raw.endedAt, 0) } : {}),
    ...(attentionReason ? { attentionReason } : {}),
    ...(num(raw.lastErrorAt) !== undefined ? { lastErrorAt: at(raw.lastErrorAt, 0) } : {}),
    subagents: count(raw.subagents),
    ...(context
      ? { context: { tokens: count(context.tokens), window: count(context.window), pct: Math.min(1, Math.max(0, num(context.pct) ?? 0)) } }
      : {}),
    ...(model ? { model } : {}),
    ...(entrypoint ? { entrypoint } : {}),
    ...(agentType ? { agentType } : {}),
    // O pid é de outra máquina: aqui não significa nada (e não pode ser usado para focar janela).
    ...(raw.alive === true ? { alive: true } : {}),
    ...(raw.remote === true ? { remote: true } : {}),
    ...(url && /^https:\/\//i.test(url) ? { url: url.slice(0, 500) } : {}),
    ...(changes ? { changes: { files: count(changes.files), added: count(changes.added), removed: count(changes.removed) } } : {}),
    machine: origin ?? machine,
    counts: { prompts: count(counts.prompts), tools: count(counts.tools), errors: count(counts.errors) },
    timeline,
    sources: { hook: sources.hook === true, watcher: sources.watcher === true },
  };
}

/** Túnel até o agent-office da outra máquina (que só escuta em 127.0.0.1 de lá). */
export interface Tunnel {
  /** Porta local que leva ao servidor remoto. */
  port: number;
  close(): void;
}

export type OpenTunnel = (peer: PeerConfig) => Promise<Tunnel>;

/**
 * Argumentos do `ssh`: só encaminha uma porta local para o 127.0.0.1 da outra
 * máquina. `BatchMode` impede qualquer pergunta (senha, chave de host nova):
 * se o acesso por chave não estiver pronto, o túnel falha com uma mensagem.
 */
export function sshArgs(target: string, localPort: number, remotePort: number): string[] {
  return [
    '-N',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    '--',
    target,
  ];
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('sem porta livre'))));
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

export const openSshTunnel: OpenTunnel = async (peer) => {
  if (!peer.ssh) throw new Error('sem destino SSH');
  const port = await freePort();
  const child = spawn('ssh', sshArgs(peer.ssh, port, peer.remotePort), { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  let exited = false;
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-600);
  });
  child.once('exit', () => {
    exited = true;
  });
  child.once('error', (err) => {
    exited = true;
    stderr = err.message;
  });
  const close = (): void => {
    if (!exited) child.kill();
  };
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (exited) break;
    if (await canConnect(port)) return { port, close };
    await new Promise((r) => setTimeout(r, 200));
  }
  close();
  const reason = stderr.trim().split('\n').pop() || 'o túnel SSH não abriu a tempo';
  throw new Error(reason.slice(0, 200));
};

export interface PeerDeps {
  openTunnel?: OpenTunnel;
  log?: (msg: string) => void;
  /** Espera inicial entre tentativas de reconexão (dobra até 30 s). */
  retryMs?: number;
}

/** Conexão com o escritório de uma máquina: espelha as sessões de lá enquanto estiver no ar. */
class PeerLink {
  private stopped = false;
  private socket: WebSocket | null = null;
  private tunnel: Tunnel | null = null;
  private timer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;
  /** Chaves das sessões que este link colocou no escritório. */
  private readonly keys = new Set<string>();
  private connected = false;
  private lastOkAt: number | null = null;
  private error: string | null = null;

  constructor(
    readonly peer: PeerConfig,
    private readonly store: SessionStore,
    private readonly deps: Required<PeerDeps>,
  ) {}

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
    this.socket?.terminate();
    this.cleanup();
  }

  status(): PeerHealth {
    return { name: this.peer.name, connected: this.connected, sessions: this.keys.size, lastOkAt: this.lastOkAt, error: this.error };
  }

  private async loop(): Promise<void> {
    let wait = this.deps.retryMs;
    while (!this.stopped) {
      try {
        let base = this.peer.url;
        if (!base) {
          this.tunnel = await this.deps.openTunnel(this.peer);
          base = `http://127.0.0.1:${this.tunnel.port}`;
        }
        if (this.stopped) break;
        const greeted = await this.listen(`${base.replace(/^http/i, 'ws').replace(/\/+$/, '')}/ws`);
        if (greeted) wait = this.deps.retryMs;
        if (!this.stopped && !this.error) this.fail('conexão encerrada pela outra máquina');
      } catch (err) {
        this.fail(err instanceof Error ? err.message : String(err));
      }
      this.cleanup();
      if (this.stopped) break;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        this.timer = setTimeout(resolve, wait);
        this.timer.unref?.();
      });
      this.wake = null;
      wait = Math.min(wait * 2, 30_000);
    }
  }

  private fail(message: string): void {
    if (message !== this.error) this.deps.log(`máquina "${this.peer.name}": ${message}`);
    this.error = message;
  }

  /** Sem conexão não dá para saber o estado das sessões de lá: elas saem do escritório. */
  private cleanup(): void {
    this.connected = false;
    this.socket = null;
    this.tunnel?.close();
    this.tunnel = null;
    for (const key of this.keys) this.store.unmirror(key);
    this.keys.clear();
  }

  /** Fica conectado até o socket fechar. Devolve true se o outro escritório chegou a se apresentar. */
  private listen(url: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { handshakeTimeout: 8000, maxPayload: 8 * 1024 * 1024 });
      this.socket = socket;
      let greeted = false;
      let offsetMs = 0;
      let lastSeen = Date.now();
      // O servidor manda um ping a cada 30 s; silêncio longo = túnel morto.
      const watchdog = setInterval(() => {
        if (Date.now() - lastSeen > 95_000) socket.terminate();
      }, 10_000);
      watchdog.unref?.();
      socket.on('ping', () => {
        lastSeen = Date.now();
      });
      socket.on('message', (data) => {
        lastSeen = Date.now();
        let msg: unknown;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        if (!isObj(msg)) return;
        if (msg.type === 'hello') {
          const serverTime = num(msg.serverTime);
          const skew = serverTime === undefined ? 0 : Date.now() - serverTime;
          // Abaixo de 2 s é só o atraso da rede: não vale mexer nos horários.
          offsetMs = Math.abs(skew) > 2000 ? skew : 0;
          const listed = new Set<string>();
          for (const raw of Array.isArray(msg.sessions) ? msg.sessions : []) {
            const key = this.mirror(raw, offsetMs);
            if (key) listed.add(key);
          }
          for (const key of [...this.keys]) {
            if (listed.has(key)) continue;
            this.store.unmirror(key);
            this.keys.delete(key);
          }
          greeted = true;
          this.connected = true;
          this.lastOkAt = Date.now();
          if (this.error) this.deps.log(`máquina "${this.peer.name}": conectada`);
          this.error = null;
        } else if (!greeted) {
          // Antes do "hello" não sabemos se é mesmo um agent-office.
        } else if (msg.type === 'session') {
          this.mirror(msg.session, offsetMs);
          this.lastOkAt = Date.now();
        } else if (msg.type === 'remove') {
          const key = str(msg.key);
          if (key && this.keys.delete(key)) this.store.unmirror(key);
        }
      });
      socket.once('error', (err) => {
        clearInterval(watchdog);
        reject(err);
      });
      socket.once('close', () => {
        clearInterval(watchdog);
        resolve(greeted);
      });
    });
  }

  private mirror(raw: unknown, offsetMs: number): string | null {
    const snapshot = mirrorSnapshot(raw, this.peer.name, offsetMs);
    if (!snapshot) return null;
    if (!this.store.mirror(snapshot)) {
      // Já existe aqui como sessão local (dois escritórios espelhando um ao outro).
      this.keys.delete(snapshot.key);
      return null;
    }
    this.keys.add(snapshot.key);
    return snapshot.key;
  }
}

/**
 * Outras máquinas: cada computador roda o seu próprio agent-office, e este
 * escritório se conecta ao dos outros (por um túnel SSH, de 127.0.0.1 a
 * 127.0.0.1) e espelha as sessões de lá, marcadas com o nome da máquina.
 * Os dados só trafegam entre os seus computadores.
 */
export class PeerManager {
  private readonly links = new Map<string, { signature: string; link: PeerLink }>();
  private timer: NodeJS.Timeout | null = null;
  private readonly deps: Required<PeerDeps>;

  constructor(
    private readonly store: SessionStore,
    private readonly settings: () => PeerConfig[],
    deps: PeerDeps = {},
  ) {
    this.deps = { openTunnel: deps.openTunnel ?? openSshTunnel, log: deps.log ?? (() => undefined), retryMs: deps.retryMs ?? 2000 };
  }

  start(intervalMs = 2000): void {
    this.stop();
    this.reconcile();
    this.timer = setInterval(() => this.reconcile(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const { link } of this.links.values()) link.stop();
    this.links.clear();
  }

  status(): PeerHealth[] {
    return [...this.links.values()].map(({ link }) => link.status());
  }

  /** Aplica a configuração atual: conecta máquinas novas e desliga as removidas ou alteradas. */
  reconcile(): void {
    const wanted = new Map(this.settings().map((peer) => [peer.name, peer]));
    for (const [name, current] of [...this.links]) {
      const peer = wanted.get(name);
      if (peer && JSON.stringify(peer) === current.signature) continue;
      current.link.stop();
      this.links.delete(name);
    }
    for (const [name, peer] of wanted) {
      if (this.links.has(name)) continue;
      const link = new PeerLink(peer, this.store, this.deps);
      this.links.set(name, { signature: JSON.stringify(peer), link });
      link.start();
    }
  }
}
