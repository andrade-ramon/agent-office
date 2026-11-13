import { existsSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import { ClaudeProcessWatcher } from './claude-procs.js';
import { HOST } from './config.js';
import { HistoryDb } from './db.js';
import { DemoSimulator } from './demo.js';
import { focusSession } from './focus.js';
import { normalizeHook, type HookEnvelope } from './normalize/hook.js';
import {
  EVENT_TYPES,
  TOOL_CATEGORIES,
  type AgentKind,
  type HealthResponse,
  type Ingest,
  type NormalizedEvent,
  type ServerMessage,
} from './schema.js';
import { SessionStore, type StoreOptions } from './state.js';
import { isObj, num, projectFromCwd, str } from './util.js';
import { TranscriptWatcher } from './watcher.js';

export interface AppOptions {
  /** Porta (0 = aleatória, útil em testes). */
  port: number;
  version?: string;
  /** Caminho do SQLite (`:memory:` para não persistir). */
  dbPath: string;
  /** Diretório do build do front-end. */
  webDir?: string;
  demo?: boolean | { concurrency?: number; speed?: number };
  watch?:
    | false
    | {
        claudeDir: string | false;
        codexDir: string | false;
        claudeSessionsDir: string | false;
        usePolling?: boolean;
      };
  store?: Partial<StoreOptions>;
  tickMs?: number;
  log?: (msg: string) => void;
}

export interface AgentOfficeApp {
  fastify: FastifyInstance;
  store: SessionStore;
  db: HistoryDb;
  watcher: TranscriptWatcher | null;
  /** Sobe o servidor em 127.0.0.1 e retorna a porta efetiva. */
  listen(): Promise<number>;
  close(): Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const DOCTOR_PREFIX = 'agent-office-doctor';

function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.toLowerCase().replace(/:\d+$/, '');
  return LOOPBACK.has(name);
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // clientes não-navegador (hooks, curl) não enviam Origin
  try {
    return LOOPBACK.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

const PLACEHOLDER = `<!doctype html><meta charset="utf-8"><title>agent-office</title>
<body style="font-family:system-ui;background:#1b1f2a;color:#e8e6df;padding:48px">
<h1>agent-office</h1>
<p>O servidor está no ar, mas o front-end ainda não foi compilado.</p>
<pre>npm run build</pre></body>`;

function isEventType(v: unknown): v is NormalizedEvent['event'] {
  return typeof v === 'string' && (EVENT_TYPES as readonly string[]).includes(v);
}
function isCategory(v: unknown): v is NormalizedEvent['toolCategory'] {
  return typeof v === 'string' && (TOOL_CATEGORIES as readonly string[]).includes(v);
}

/** Valida um evento já normalizado recebido em POST /events. */
function coerceEvent(raw: unknown, now: number): NormalizedEvent | null {
  if (!isObj(raw)) return null;
  const agent: AgentKind | null = raw.agent === 'claude' || raw.agent === 'codex' ? raw.agent : null;
  const sessionId = str(raw.sessionId);
  if (!agent || !sessionId || !isEventType(raw.event)) return null;
  const cwd = str(raw.cwd) ?? '';
  const parent = str(raw.parentSessionId);
  const toolName = str(raw.toolName);
  const meta = isObj(raw.meta) ? raw.meta : undefined;
  const toolUseId = meta ? str(meta.toolUseId) : undefined;
  return {
    agent,
    sessionId,
    ...(parent ? { parentSessionId: parent } : {}),
    cwd,
    project: str(raw.project) ?? projectFromCwd(cwd),
    event: raw.event,
    toolCategory: isCategory(raw.toolCategory) ? raw.toolCategory : 'other',
    ts: num(raw.ts) ?? now,
    ...(toolName ? { toolName } : {}),
    source: raw.source === 'demo' ? 'demo' : 'hook',
    ...(toolUseId ? { meta: { toolUseId } } : {}),
  };
}

export async function createApp(opts: AppOptions): Promise<AgentOfficeApp> {
  const version = opts.version ?? '0.0.0';
  const log = opts.log ?? (() => undefined);
  const startedAt = Date.now();
  const store = new SessionStore(opts.store);
  const db = await HistoryDb.open(opts.dbPath);
  const fastify = Fastify({ logger: false, bodyLimit: 512 * 1024 });
  const wss = new WebSocketServer({ noServer: true });

  const counters = { total: 0, hook: 0, watcher: 0 };
  const lastHookAt: Record<AgentKind, number | null> = { claude: null, codex: null };
  let port = opts.port;
  const webBuilt = Boolean(opts.webDir && existsSync(join(opts.webDir, 'index.html')));

  // ─────────── broadcast ───────────
  const broadcast = (msg: ServerMessage): void => {
    if (wss.clients.size === 0) return;
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  };

  store.on('session', (session) => broadcast({ type: 'session', session }));
  store.on('remove', (key) => broadcast({ type: 'remove', key }));
  store.on('event', (key, event, session) => {
    counters.total++;
    if (event.source === 'hook') counters.hook++;
    if (event.source === 'watcher') counters.watcher++;
    try {
      db.recordEvent(event);
      db.upsertSession(session);
    } catch (err) {
      log(`sqlite: ${String(err)}`);
    }
    broadcast({ type: 'event', key, event });
  });

  // ─────────── segurança: só loopback ───────────
  fastify.addHook('onRequest', async (req, reply) => {
    if (!hostAllowed(req.headers.host)) {
      return reply.code(403).send({ error: 'host não permitido' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(req.headers.origin)) {
      return reply.code(403).send({ error: 'origem não permitida' });
    }
  });

  // ─────────── ingestão ───────────
  fastify.post('/events', async (req, reply) => {
    const body = req.body;
    const now = Date.now();
    const items: Ingest[] = [];

    if (isObj(body) && isObj(body.payload)) {
      const env = body as unknown as HookEnvelope;
      const agent: AgentKind = env.agent === 'codex' ? 'codex' : 'claude';
      lastHookAt[agent] = now;
      const sid = str(env.payload.session_id) ?? '';
      if (sid.startsWith(DOCTOR_PREFIX)) {
        counters.total++;
        counters.hook++;
        return reply.send({ ok: true, accepted: 0, doctor: true });
      }
      items.push(...normalizeHook(env, now));
    } else if (isObj(body) && Array.isArray(body.events)) {
      for (const raw of body.events.slice(0, 500)) {
        const ev = coerceEvent(raw, now);
        if (ev) items.push(ev);
      }
    } else {
      return reply.code(400).send({ ok: false, error: 'corpo inválido' });
    }

    let accepted = 0;
    for (const item of items) {
      if (store.apply(item)) accepted++;
    }
    return reply.send({ ok: true, accepted });
  });

  // ─────────── API ───────────
  fastify.get('/api/health', async (): Promise<HealthResponse> => {
    const w = watcher?.stats() ?? { claudeFiles: 0, codexFiles: 0, tracked: 0 };
    return {
      ok: true,
      name: 'agent-office',
      version,
      host: HOST,
      port,
      pid: process.pid,
      uptimeMs: Date.now() - startedAt,
      demo: Boolean(opts.demo),
      sessions: store.size,
      clients: wss.clients.size,
      events: { ...counters },
      lastHookAt: { ...lastHookAt },
      watcher: { enabled: Boolean(watcher), ...w },
      webBuilt,
    };
  });

  fastify.get('/api/sessions', async () => ({ sessions: store.list() }));
  fastify.get('/api/stats', async () => db.stats());
  fastify.get('/api/history', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return { events: db.recentEvents(Number(q.limit ?? 100) || 100) };
  });

  fastify.post('/api/sessions/:key/focus', async (req, reply) => {
    const { key } = req.params as { key: string };
    const session = store.get(key);
    if (!session) return reply.code(404).send({ ok: false, detail: 'Sessão não encontrada.' });
    // Subagentes vivem dentro do processo do pai.
    const target = session.parentKey ? (store.get(session.parentKey) ?? session) : session;
    return focusSession(target);
  });

  // ─────────── front-end estático ───────────
  if (webBuilt && opts.webDir) {
    await fastify.register(fastifyStatic, {
      root: opts.webDir,
      wildcard: false,
      setHeaders(res, path) {
        if (path.endsWith('index.html')) res.header('Cache-Control', 'no-cache');
        else if (/[\\/]assets[\\/]/.test(path)) res.header('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
    fastify.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/events')) {
        return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'não encontrado' });
    });
  } else {
    fastify.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(PLACEHOLDER));
  }

  // ─────────── WebSocket (/ws) ───────────
  fastify.server.on('upgrade', (req: IncomingMessage, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      /* url inválida */
    }
    if (pathname !== '/ws' || !hostAllowed(req.headers.host) || !originAllowed(req.headers.origin)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const alive = new WeakMap<WebSocket, boolean>();
  wss.on('connection', (ws) => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    ws.on('error', () => undefined);
    ws.on('message', (data) => {
      if (String(data).slice(0, 64).includes('ping')) ws.send('{"type":"pong"}');
    });
    const hello: ServerMessage = {
      type: 'hello',
      version,
      serverTime: Date.now(),
      demo: Boolean(opts.demo),
      config: { idleAfterMs: store.options.idleAfterMs, endAfterMs: store.options.endAfterMs },
      sessions: store.list(),
    };
    ws.send(JSON.stringify(hello));
  });

  // ─────────── fontes ───────────
  let watcher: TranscriptWatcher | null = null;
  let procs: ClaudeProcessWatcher | null = null;
  let demo: DemoSimulator | null = null;
  const timers: NodeJS.Timeout[] = [];

  const startSources = async (): Promise<void> => {
    if (opts.watch) {
      watcher = new TranscriptWatcher({
        store,
        claudeDir: opts.watch.claudeDir,
        codexDir: opts.watch.codexDir,
        bootstrapWindowMs: store.options.endAfterMs,
        ...(opts.watch.usePolling ? { usePolling: true } : {}),
        log,
      });
      const t0 = Date.now();
      await watcher.start();
      const s = watcher.stats();
      log(`watcher pronto em ${Date.now() - t0}ms (claude: ${s.claudeFiles} arquivos, codex: ${s.codexFiles})`);
      if (opts.watch.claudeSessionsDir) {
        procs = new ClaudeProcessWatcher(opts.watch.claudeSessionsDir, store);
        await procs.start();
      }
      store.tick();
    }
    if (opts.demo) {
      const d = typeof opts.demo === 'object' ? opts.demo : {};
      demo = new DemoSimulator(store, d.concurrency ?? 7, d.speed ?? 1);
      demo.start();
    }
  };

  return {
    fastify,
    store,
    db,
    get watcher() {
      return watcher;
    },
    async listen() {
      await fastify.listen({ host: HOST, port: opts.port });
      port = (fastify.server.address() as AddressInfo).port;

      timers.push(setInterval(() => store.tick(), opts.tickMs ?? 5000));
      timers.push(
        setInterval(() => {
          for (const ws of wss.clients) {
            if (alive.get(ws) === false) {
              ws.terminate();
              continue;
            }
            alive.set(ws, false);
            ws.ping();
          }
        }, 30_000),
      );
      timers.push(setInterval(() => db.prune(), 6 * 60 * 60 * 1000));
      for (const t of timers) t.unref?.();
      try {
        db.prune();
      } catch {
        /* melhor esforço */
      }

      // As fontes sobem depois do listen: os hooks já podem entregar eventos
      // enquanto a varredura inicial dos transcripts acontece.
      await startSources();
      return port;
    },
    async close() {
      for (const t of timers) clearInterval(t);
      demo?.stop();
      procs?.stop();
      await watcher?.stop();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await fastify.close();
      store.dispose();
      db.close();
    },
  };
}
