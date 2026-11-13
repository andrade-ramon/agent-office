import { open, type FileHandle } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import chokidar, { type FSWatcher } from 'chokidar';
import type { Stats } from 'node:fs';
import { ClaudeTranscriptParser, classifyClaudePath } from './normalize/claude.js';
import { CodexRolloutParser, codexSessionIdFromPath } from './normalize/codex.js';
import { sessionKey, type AgentKind, type Ingest } from './schema.js';
import type { SessionStore } from './state.js';

const TAIL_BYTES = 512 * 1024;
const CHUNK_BYTES = 256 * 1024;
const MAX_LINE_CHARS = 16 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LineParser {
  parse(line: unknown): Ingest[];
}

interface Tracked {
  agent: AgentKind;
  path: string;
  /** Chave da sessão que este arquivo alimenta. */
  key: string;
  parser: LineParser;
  offset: number;
  partial: string;
  /** Descarta a primeira linha (cauda lida a partir do meio do arquivo). */
  skipFirst: boolean;
  /** Linha grande demais: ignora até o próximo \n. */
  overflow: boolean;
  queue: Promise<void>;
}

export interface WatcherOptions {
  store: SessionStore;
  /** `~/.claude/projects` (false desativa). */
  claudeDir: string | false;
  /** `~/.codex/sessions` (false desativa). */
  codexDir: string | false;
  /** Arquivos modificados dentro desta janela são reconstruídos na partida. */
  bootstrapWindowMs: number;
  /** Força polling (usado em testes/sistemas de arquivo sem eventos). */
  usePolling?: boolean;
  log?: (msg: string) => void;
}

/**
 * Observa os transcripts do Claude Code e os rollouts do Codex com chokidar.
 * É a via de ingestão de reserva (e a única para sessões abertas antes dos
 * hooks serem instalados).
 */
export class TranscriptWatcher {
  private readonly watchers: FSWatcher[] = [];
  private readonly tracked = new Map<string, Tracked>();
  /** Arquivos antigos conhecidos: só guardamos o tamanho para seguir depois. */
  private readonly dormant = new Map<string, number>();
  private ready = false;
  private counts = { claude: 0, codex: 0 };

  constructor(private readonly opts: WatcherOptions) {}

  stats(): { claudeFiles: number; codexFiles: number; tracked: number } {
    return { claudeFiles: this.counts.claude, codexFiles: this.counts.codex, tracked: this.tracked.size };
  }

  /** Inicia os watchers. Resolve quando a varredura inicial termina. */
  async start(): Promise<void> {
    const pending: Promise<void>[] = [];
    const startup: Promise<void>[] = [];
    if (this.opts.claudeDir) pending.push(this.watchRoot('claude', this.opts.claudeDir, startup));
    if (this.opts.codexDir) pending.push(this.watchRoot('codex', this.opts.codexDir, startup));
    await Promise.all(pending);
    await Promise.all(startup);
    this.ready = true;
  }

  async stop(): Promise<void> {
    await Promise.all(this.watchers.map((w) => w.close().catch(() => undefined)));
    this.watchers.length = 0;
    await Promise.all([...this.tracked.values()].map((t) => t.queue.catch(() => undefined)));
  }

  /** Aguarda as leituras em andamento (útil em testes). */
  async idle(): Promise<void> {
    await Promise.all([...this.tracked.values()].map((t) => t.queue.catch(() => undefined)));
  }

  private watchRoot(agent: AgentKind, root: string, startup: Promise<void>[]): Promise<void> {
    const ignored =
      agent === 'claude'
        ? (p: string): boolean => {
            const rel = relative(root, p);
            if (!rel) return false;
            const parts = rel.split(sep);
            switch (parts.length) {
              case 1:
                return false;
              case 2:
                return !(parts[1]!.endsWith('.jsonl') || UUID_RE.test(parts[1]!));
              case 3:
                return parts[2] !== 'subagents';
              case 4:
                return !/^agent-.+\.jsonl$/.test(parts[3]!);
              default:
                return true;
            }
          }
        : (p: string, stats?: Stats): boolean => {
            if (stats?.isFile()) return codexSessionIdFromPath(p) === null;
            return false;
          };

    const watcher = chokidar.watch(root, {
      persistent: true,
      ignoreInitial: false,
      alwaysStat: true,
      followSymlinks: false,
      depth: 3,
      ignored,
      usePolling: this.opts.usePolling ?? false,
      interval: 150,
      ignorePermissionErrors: true,
    });
    this.watchers.push(watcher);

    watcher.on('add', (path, stats) => {
      const work = this.onAdd(agent, root, path, stats);
      if (!this.ready) startup.push(work);
    });
    watcher.on('change', (path) => this.onChange(agent, root, path));
    watcher.on('unlink', (path) => this.onUnlink(path));
    watcher.on('error', (err) => this.opts.log?.(`watcher ${agent}: ${String(err)}`));

    return new Promise<void>((resolve) => {
      watcher.once('ready', () => resolve());
    });
  }

  private identify(agent: AgentKind, root: string, path: string): { key: string; make: (fresh: boolean) => LineParser } | null {
    if (agent === 'claude') {
      const info = classifyClaudePath(relative(root, path));
      if (!info) return null;
      return {
        key: sessionKey('claude', info.agentId ?? info.sessionId),
        make: (fresh) => new ClaudeTranscriptParser(info, { fresh }),
      };
    }
    const id = codexSessionIdFromPath(path);
    if (!id) return null;
    return { key: sessionKey('codex', id), make: () => new CodexRolloutParser(id) };
  }

  private track(agent: AgentKind, path: string, key: string, parser: LineParser, offset: number): Tracked {
    const t: Tracked = {
      agent,
      path,
      key,
      parser,
      offset,
      partial: '',
      skipFirst: false,
      overflow: false,
      queue: Promise.resolve(),
    };
    this.tracked.set(path, t);
    this.dormant.delete(path);
    return t;
  }

  private enqueue(t: Tracked, job: () => Promise<void>): Promise<void> {
    t.queue = t.queue.then(job).catch((err) => {
      this.opts.log?.(`leitura falhou (${t.path}): ${String(err)}`);
    });
    return t.queue;
  }

  private async onAdd(agent: AgentKind, root: string, path: string, stats?: Stats): Promise<void> {
    const id = this.identify(agent, root, path);
    if (!id) return;
    this.counts[agent]++;
    const size = stats?.size ?? 0;

    if (this.ready) {
      // Arquivo novo: sessão nova, lê desde o início.
      const t = this.track(agent, path, id.key, id.make(true), 0);
      await this.enqueue(t, () => this.drain(t, false));
      return;
    }

    const age = Date.now() - (stats?.mtimeMs ?? 0);
    if (age > this.opts.bootstrapWindowMs) {
      this.dormant.set(path, size);
      return;
    }
    // Sessão recente: reconstrói o estado a partir da cauda, sem emitir eventos.
    const t = this.track(agent, path, id.key, id.make(false), 0);
    await this.enqueue(t, async () => {
      const start = Math.max(0, size - TAIL_BYTES);
      if (start > 0) {
        if (agent === 'codex') await this.readHead(t);
        t.offset = start;
        t.skipFirst = true;
      }
      await this.drain(t, true);
    });
  }

  private onChange(agent: AgentKind, root: string, path: string): void {
    let t = this.tracked.get(path);
    if (!t) {
      const id = this.identify(agent, root, path);
      if (!id) return;
      // Sessão antiga retomada: segue a partir do tamanho conhecido.
      const offset = this.dormant.get(path) ?? 0;
      t = this.track(agent, path, id.key, id.make(false), offset);
      const created = t;
      if (agent === 'codex' && offset > 0) void this.enqueue(created, () => this.readHead(created));
    }
    const target = t;
    void this.enqueue(target, () => this.drain(target, false));
  }

  private onUnlink(path: string): void {
    this.dormant.delete(path);
    const t = this.tracked.get(path);
    if (!t) return;
    this.tracked.delete(path);
    // Arquivo removido/arquivado: a sessão acabou.
    this.opts.store.end(t.key, Date.now(), 'file_removed');
  }

  /** Lê a primeira linha (session_meta do Codex) sem mexer no offset. */
  private async readHead(t: Tracked): Promise<void> {
    let fh: FileHandle | undefined;
    try {
      fh = await open(t.path, 'r');
      const decoder = new StringDecoder('utf8');
      const buf = Buffer.allocUnsafe(CHUNK_BYTES);
      let text = '';
      let pos = 0;
      while (text.length < MAX_LINE_CHARS) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        text += decoder.write(buf.subarray(0, bytesRead));
        const nl = text.indexOf('\n');
        if (nl >= 0) {
          text = text.slice(0, nl);
          break;
        }
      }
      this.feed(t, text, true);
    } catch {
      /* arquivo sumiu: ignora */
    } finally {
      await fh?.close().catch(() => undefined);
    }
  }

  /** Lê do offset até o fim do arquivo, linha a linha. */
  private async drain(t: Tracked, replay: boolean): Promise<void> {
    let fh: FileHandle | undefined;
    try {
      fh = await open(t.path, 'r');
      const { size } = await fh.stat();
      if (size < t.offset) {
        t.offset = 0;
        t.partial = '';
        t.skipFirst = false;
        t.overflow = false;
      }
      const decoder = new StringDecoder('utf8');
      const buf = Buffer.allocUnsafe(CHUNK_BYTES);
      while (t.offset < size) {
        const want = Math.min(buf.length, size - t.offset);
        const { bytesRead } = await fh.read(buf, 0, want, t.offset);
        if (bytesRead <= 0) break;
        t.offset += bytesRead;
        this.consume(t, decoder.write(buf.subarray(0, bytesRead)), replay);
      }
    } catch {
      /* arquivo sumiu ou sem permissão: tenta de novo na próxima mudança */
    } finally {
      await fh?.close().catch(() => undefined);
    }
  }

  private consume(t: Tracked, text: string, replay: boolean): void {
    let data = t.partial + text;
    t.partial = '';
    let nl = data.indexOf('\n');
    while (nl >= 0) {
      const line = data.slice(0, nl);
      data = data.slice(nl + 1);
      if (t.overflow) {
        t.overflow = false;
      } else if (t.skipFirst) {
        t.skipFirst = false;
      } else {
        this.feed(t, line, replay);
      }
      nl = data.indexOf('\n');
    }
    if (data.length > MAX_LINE_CHARS) {
      t.overflow = true;
      data = '';
    }
    t.partial = data;
  }

  private feed(t: Tracked, line: string, replay: boolean): void {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') return;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return;
    }
    let items: Ingest[];
    try {
      items = t.parser.parse(obj);
    } catch {
      return;
    }
    for (const item of items) this.opts.store.apply(item, { replay });
  }
}
