import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionKey, type NormalizedEvent } from './schema.js';
import type { SessionStore } from './state.js';
import { isObj, num, projectFromCwd, str } from './util.js';

interface ProcEntry {
  file: string;
  mtimeMs: number;
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  entrypoint?: string;
  status?: string;
  /** Presente quando status = "waiting" (ex.: "permission prompt"). */
  waitingFor?: string;
  /** Título da sessão (o mesmo da barra lateral do app). */
  name?: string;
  statusUpdatedAt: number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const BUSY_FROM = new Set(['done', 'idle']);
const IDLE_FROM = new Set(['thinking', 'working', 'starting', 'permission_wait', 'waiting_input']);
const WAITING = new Set(['permission_wait', 'waiting_input']);

/**
 * O Claude Code mantém um arquivo por processo vivo em `~/.claude/sessions/<pid>.json`
 * (pid, sessionId, cwd, status). Usamos isso — só metadados — para:
 *   • mostrar sessões que já estavam abertas, mesmo paradas há horas;
 *   • saber que a sessão está parada esperando você (status "waiting"), e
 *     quando voltou a trabalhar — mesmo sem hooks;
 *   • saber quando o processo saiu (fim de sessão sem depender de timeout);
 *   • trazer a janela certa para frente (pid).
 */
export class ClaudeProcessWatcher {
  private readonly entries = new Map<string, ProcEntry>();
  private timer: NodeJS.Timeout | null = null;
  private first = true;
  private polling = false;

  constructor(
    private readonly dir: string,
    private readonly store: SessionStore,
    private readonly intervalMs = 3000,
  ) {}

  async start(): Promise<void> {
    await this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(now: number = Date.now()): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.scan(now);
    } catch {
      /* diretório ausente ou ilegível: nada a fazer */
    } finally {
      this.first = false;
      this.polling = false;
    }
  }

  private async scan(now: number): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(this.dir)).filter((n) => /^\d+\.json$/.test(n));
    } catch {
      names = [];
    }
    const seen = new Set<string>();
    const replay = this.first;

    for (const name of names) {
      const file = join(this.dir, name);
      let entry = this.entries.get(file);
      try {
        const st = await stat(file);
        if (!entry || entry.mtimeMs !== st.mtimeMs) {
          const parsed = parseEntry(file, st.mtimeMs, JSON.parse(await readFile(file, 'utf8')));
          if (!parsed) continue;
          if (entry && entry.sessionId !== parsed.sessionId) {
            // Mesmo processo, sessão nova (/clear, /resume): a antiga acabou.
            this.store.end(sessionKey('claude', entry.sessionId), now, 'session_replaced', { replay });
          }
          entry = parsed;
          this.entries.set(file, entry);
        }
      } catch {
        continue;
      }
      if (!pidAlive(entry.pid)) continue;
      seen.add(file);
      this.sync(entry, now, replay);
    }

    for (const [file, entry] of [...this.entries]) {
      if (seen.has(file)) continue;
      this.entries.delete(file);
      this.store.end(sessionKey('claude', entry.sessionId), now, 'process_exit', { replay });
    }

    if (this.first && existsSync(this.dir)) {
      // Na partida: sessões reconstruídas dos transcripts cujo processo já não
      // existe (ex.: `claude -p` que terminou) não devem voltar como "ociosas".
      for (const s of this.store.list()) {
        if (s.agent === 'claude' && !s.parentKey && !s.alive && s.status !== 'ended') {
          this.store.end(s.key, s.lastActivityAt + 1, 'no_process', { replay: true });
        }
      }
    }
  }

  private sync(entry: ProcEntry, now: number, replay: boolean): void {
    const key = sessionKey('claude', entry.sessionId);
    const base = (event: NormalizedEvent['event'], ts: number): NormalizedEvent => ({
      agent: 'claude',
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      project: projectFromCwd(entry.cwd),
      event,
      toolCategory: 'other',
      ts,
      source: 'system',
    });

    const s = this.store.get(key);
    if (!s || s.status === 'ended') {
      // Processo vivo sem atividade recente no transcript: cria a partir do pid file.
      const startTs = replay ? entry.statusUpdatedAt || entry.startedAt || now : now;
      this.store.apply(base('session_start', startTs), { replay });
      if (entry.status === 'busy') this.store.apply(base('prompt', startTs + 1), { replay: true });
      else if (entry.status === 'idle') this.store.apply(base('stop', startTs + 1), { replay: true });
      else if (entry.status === 'waiting') this.store.apply(base(waitingEvent(entry), startTs + 1), { replay });
    } else if (entry.status === 'waiting') {
      // Parada esperando o usuário (pedido de permissão ou pergunta).
      if (!WAITING.has(s.status)) {
        this.store.apply(base(waitingEvent(entry), Math.max(entry.statusUpdatedAt, s.lastActivityAt + 1)), { replay });
      }
    } else if (entry.status === 'idle') {
      // O processo diz que terminou o turno, mas não vimos o fim (ex.: interrupção).
      if (IDLE_FROM.has(s.status) && entry.statusUpdatedAt >= s.lastActivityAt - 2000 && now - s.lastActivityAt > 6000) {
        this.store.apply(base('stop', Math.max(entry.statusUpdatedAt, s.lastActivityAt + 1)), { replay });
      }
    } else if (entry.status === 'busy') {
      if (WAITING.has(s.status)) {
        // O usuário respondeu (permissão concedida/negada): o agente voltou ao trabalho.
        if (entry.statusUpdatedAt >= s.statusSince - 1000) this.store.resume(key, Math.max(entry.statusUpdatedAt, s.lastActivityAt + 1));
      } else if (BUSY_FROM.has(s.status) && entry.statusUpdatedAt > s.lastActivityAt + 2000) {
        // O processo voltou a trabalhar e ainda não vimos o prompt.
        this.store.apply(base('prompt', entry.statusUpdatedAt), { replay });
      }
    }

    this.store.apply({
      kind: 'meta',
      agent: 'claude',
      sessionId: entry.sessionId,
      ts: now,
      cwd: entry.cwd,
      meta: {
        alive: true,
        pid: entry.pid,
        ...(entry.entrypoint ? { entrypoint: entry.entrypoint } : {}),
        ...(entry.name ? { title: entry.name } : {}),
      },
    });
  }
}

function waitingEvent(entry: ProcEntry): 'permission_wait' | 'waiting_input' {
  return /permission/i.test(entry.waitingFor ?? '') ? 'permission_wait' : 'waiting_input';
}

function parseEntry(file: string, mtimeMs: number, raw: unknown): ProcEntry | null {
  if (!isObj(raw)) return null;
  const pid = num(raw.pid);
  const sessionId = str(raw.sessionId);
  if (!pid || !sessionId) return null;
  const entrypoint = str(raw.entrypoint);
  const status = str(raw.status);
  const waitingFor = str(raw.waitingFor);
  const name = str(raw.name);
  return {
    file,
    mtimeMs,
    pid,
    sessionId,
    cwd: str(raw.cwd) ?? '',
    startedAt: num(raw.startedAt) ?? 0,
    ...(entrypoint ? { entrypoint } : {}),
    ...(status ? { status } : {}),
    ...(waitingFor ? { waitingFor } : {}),
    ...(name ? { name } : {}),
    statusUpdatedAt: num(raw.statusUpdatedAt) ?? num(raw.updatedAt) ?? 0,
  };
}
