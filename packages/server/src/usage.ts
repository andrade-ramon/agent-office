import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { open, readdir, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database, Statement } from './db.js';
import { ClaudeTranscriptParser } from './normalize/claude.js';
import { CodexRolloutParser, codexSessionIdFromPath } from './normalize/codex.js';
import {
  TOOL_CATEGORIES,
  type AgentKind,
  type Ingest,
  type TokenUsage,
  type ToolCategory,
  type UsageDay,
  type UsageRank,
  type UsageResponse,
  type UsageTotals,
} from './schema.js';
import { isObj, str } from './util.js';

/**
 * Painel de dados: o acumulado de todas as sessões.
 *
 * Os hooks não informam tokens, e o watcher ao vivo só lê a cauda dos
 * arquivos; por isso o livro-razão lê os transcripts por conta própria, do
 * início, guardando no SQLite até onde já leu (nada é contado duas vezes, nem
 * depois de reiniciar) e somando tudo em contadores por dia. Guarda só
 * números, nomes de modelo e nomes de projeto — nunca conteúdo.
 */

/** Um transcript (Claude) ou rollout (Codex) no disco. */
export interface TranscriptFile {
  agent: AgentKind;
  path: string;
  /** Sessão dona do arquivo (para subagentes do Claude, a sessão-pai). */
  sessionId: string;
  /** Presente quando o arquivo é o transcript de um subagente do Claude. */
  subagentId?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_counters (
  day INTEGER NOT NULL,
  agent TEXT NOT NULL,
  metric TEXT NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (day, agent, metric)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS usage_files (
  key TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  offset INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_seen (
  h INTEGER PRIMARY KEY,
  day INTEGER NOT NULL
);
`;

const DAY_MS = 24 * 60 * 60 * 1000;
const CHUNK_BYTES = 1024 * 1024;
/** Linha maior que isto é descartada sem ser lida. */
const MAX_LINE_BYTES = 48 * 1024 * 1024;
/** Em arquivos grandes, grava o progresso a cada tanto. */
const FLUSH_BYTES = 16 * 1024 * 1024;
/**
 * Pausa entre dois eventos de um turno conta, no máximo, isto como tempo
 * ativo — o mesmo prazo em que o personagem passa a "ocioso" no escritório.
 */
export const ACTIVE_GAP_MS = 5 * 60_000;
/** Por quanto tempo lembrar das linhas já contadas (histórico copiado entre arquivos). */
const SEEN_DAYS = 60;
const RANK_SIZE = 5;
const DAYS_SHOWN = 14;
const MAX_PARSE_CHARS = 4 * 1024 * 1024;
const MAX_PARSERS = 200;
const EMPTY = Buffer.alloc(0);

/** Depois destes eventos a sessão está parada, esperando o usuário. */
const RESTS = new Set(['stop', 'subagent_stop', 'session_end', 'waiting_input', 'permission_wait']);
/** Eventos que não dizem se há trabalho em andamento. */
const NEUTRAL = new Set(['session_start', 'subagent_start']);

interface FileState {
  /** Subagente (conta à parte das sessões principais). */
  sub: boolean;
  /** A sessão já entrou na contagem de sessões. */
  counted: boolean;
  model: string;
  project: string;
  /** Há um turno em andamento. */
  busy: boolean;
  lastTs: number;
  /** Claude: resposta em andamento e quanto dela já foi contado. */
  msgId: string;
  msg: TokenUsage;
  /** Codex: acumulado da sessão já contado. */
  total: TokenUsage | null;
}

interface LineParser {
  parse(line: unknown): Ingest[];
}

/** Uma leitura em andamento: o que mudou e ainda não foi gravado. */
interface Scan {
  file: TranscriptFile;
  key: string;
  state: FileState;
  parser: LineParser;
  deltas: Map<string, number>;
  marks: Map<bigint, number>;
}

const ZERO: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function sum(u: TokenUsage): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite;
}

function diff(now: TokenUsage, before: TokenUsage): TokenUsage {
  return {
    input: Math.max(0, now.input - before.input),
    output: Math.max(0, now.output - before.output),
    cacheRead: Math.max(0, now.cacheRead - before.cacheRead),
    cacheWrite: Math.max(0, now.cacheWrite - before.cacheWrite),
  };
}

function hash64(text: string): bigint {
  return createHash('sha1').update(text).digest().readBigInt64BE(0);
}

function n(v: unknown): number {
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0;
}

function blankTotals(): UsageTotals {
  return {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    prompts: 0,
    tools: 0,
    errors: 0,
    sessions: 0,
    subagents: 0,
    activeMs: 0,
    subagentActiveMs: 0,
  };
}

/** Soma uma métrica simples nos totais; devolve quantos tokens ela representa. */
function addMetric(t: UsageTotals, metric: string, v: number): number {
  switch (metric) {
    case 'in':
      t.tokens.input += v;
      break;
    case 'out':
      t.tokens.output += v;
      break;
    case 'cr':
      t.tokens.cacheRead += v;
      break;
    case 'cw':
      t.tokens.cacheWrite += v;
      break;
    case 'prompts':
      t.prompts += v;
      return 0;
    case 'tools':
      t.tools += v;
      return 0;
    case 'errors':
      t.errors += v;
      return 0;
    case 'sessions':
      t.sessions += v;
      return 0;
    case 'subagents':
      t.subagents += v;
      return 0;
    case 'active':
      t.activeMs += v;
      return 0;
    case 'subActive':
      t.subagentActiveMs += v;
      return 0;
    default:
      return 0;
  }
  t.tokens.total += v;
  return v;
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Meia-noite local de `days` dias antes do dia de `ts` (respeita horário de verão). */
function daysBefore(ts: number, days: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d.getTime();
}

function top(map: Map<string, number>): UsageRank[] {
  return [...map]
    .filter(([, tokens]) => tokens > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, RANK_SIZE)
    .map(([name, tokens]) => ({ name, tokens }));
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface UsageLedgerOptions {
  now?: () => number;
  log?: (msg: string) => void;
}

export class UsageLedger extends EventEmitter<{ change: [] }> {
  private readonly addStmt: Statement;
  private readonly markStmt: Statement;
  private readonly seenStmt: Statement;
  private readonly cursorStmt: Statement;
  private readonly loadStmt: Statement;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly queue = new Map<string, TranscriptFile>();
  private readonly parsers = new Map<string, LineParser>();
  private worker: Promise<void> | null = null;
  private stopped = false;
  private done = 0;
  private cached: { day: number; value: Omit<UsageResponse, 'updatedAt' | 'scan'> } | null = null;
  private dayLo = 0;
  private dayHi = 0;

  constructor(
    private readonly db: Database,
    opts: UsageLedgerOptions = {},
  ) {
    super();
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => undefined);
    db.exec(SCHEMA);
    this.addStmt = db.prepare(
      `INSERT INTO usage_counters (day, agent, metric, value) VALUES (?, ?, ?, ?)
       ON CONFLICT(day, agent, metric) DO UPDATE SET value = value + excluded.value`,
    );
    this.markStmt = db.prepare('INSERT OR IGNORE INTO usage_seen (h, day) VALUES (?, ?)');
    this.seenStmt = db.prepare('SELECT 1 AS x FROM usage_seen WHERE h = ?');
    this.cursorStmt = db.prepare(
      `INSERT INTO usage_files (key, path, offset, updated, state) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET path = excluded.path, offset = excluded.offset, updated = excluded.updated, state = excluded.state`,
    );
    this.loadStmt = db.prepare('SELECT path, offset, state FROM usage_files WHERE key = ?');
  }

  // ───────────────────────── leitura dos arquivos ─────────────────────────

  /** Avisa que um arquivo existe ou cresceu; a leitura acontece em segundo plano. */
  touch(file: TranscriptFile): void {
    if (this.stopped) return;
    this.queue.set(cursorKey(file), file);
    this.worker ??= this.drain().finally(() => {
      this.worker = null;
    });
  }

  /** Enfileira os rollouts de uma pasta do Codex (as sessões arquivadas saem da pasta observada). */
  async touchCodexDir(dir: string, depth = 4): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth > 0) await this.touchCodexDir(path, depth - 1);
        continue;
      }
      const sessionId = codexSessionIdFromPath(path);
      if (sessionId) this.touch({ agent: 'codex', path, sessionId });
    }
  }

  /** Espera a fila esvaziar (testes e encerramento). */
  async idle(): Promise<void> {
    while (this.worker) await this.worker;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.queue.clear();
    await this.idle();
    this.removeAllListeners();
  }

  private async drain(): Promise<void> {
    let lastNotice = this.now();
    while (this.queue.size > 0 && !this.stopped) {
      const [key, file] = this.queue.entries().next().value as [string, TranscriptFile];
      this.queue.delete(key);
      try {
        await this.scan(file);
      } catch (err) {
        this.log(`painel de dados: ${file.path}: ${String(err)}`);
      }
      this.done++;
      // Durante a leitura do histórico, o painel vai mostrando o progresso.
      if (this.queue.size > 0 && this.now() - lastNotice > 1000) {
        lastNotice = this.now();
        this.emit('change');
      }
      await tick();
    }
    this.done = 0;
    this.emit('change');
  }

  /** Lê do ponto em que parou até o fim do arquivo. */
  async scan(file: TranscriptFile): Promise<void> {
    const key = cursorKey(file);
    const saved = this.loadStmt.get(key);
    let offset = saved ? n(saved.offset) : 0;
    const state = saved ? parseState(saved.state, file) : blankState(file);

    let fh: FileHandle | undefined;
    try {
      fh = await open(file.path, 'r');
      const { size } = await fh.stat();
      if (size < offset) {
        // Arquivo reescrito. No Claude as linhas já contadas são reconhecidas
        // uma a uma; no Codex não há como, então segue do novo fim.
        offset = file.agent === 'claude' ? 0 : size;
      }
      if (size <= offset) {
        // Nada novo; se o arquivo mudou de pasta (sessão arquivada), anota o novo caminho.
        if (saved && String(saved.path) !== file.path) {
          this.cursorStmt.run(key, file.path, offset, this.now(), JSON.stringify(state));
        }
        return;
      }

      const scan: Scan = {
        file,
        key,
        state,
        parser: this.parserFor(key, file),
        deltas: new Map(),
        marks: new Map(),
      };
      let pos = offset;
      let carry: Buffer = EMPTY;
      let skipping = false;
      let flushedAt = offset;
      while (pos < size && !this.stopped) {
        const want = Math.min(CHUNK_BYTES, size - pos);
        const buf = Buffer.allocUnsafe(want);
        const { bytesRead } = await fh.read(buf, 0, want, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        const data = carry.length > 0 ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        let start = 0;
        for (;;) {
          const nl = data.indexOf(10, start);
          if (nl < 0) break;
          if (skipping) skipping = false;
          else if (nl > start) this.line(scan, data.toString('utf8', start, nl));
          start = nl + 1;
        }
        carry = start < data.length ? data.subarray(start) : EMPTY;
        if (carry.length > MAX_LINE_BYTES) {
          carry = EMPTY;
          skipping = true;
        }
        // Só linhas completas contam como lidas.
        const consumed = pos - carry.length;
        if (consumed - flushedAt >= FLUSH_BYTES) {
          this.flush(scan, consumed);
          flushedAt = consumed;
        }
      }
      if (!this.stopped) this.flush(scan, pos - carry.length);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    } finally {
      await fh?.close().catch(() => undefined);
    }
  }

  /** Os parsers das sessões em andamento ficam à mão; os do histórico são descartados. */
  private parserFor(key: string, file: TranscriptFile): LineParser {
    const parser =
      this.parsers.get(key) ??
      (file.agent === 'claude'
        ? new ClaudeTranscriptParser({ sessionId: file.sessionId, ...(file.subagentId ? { agentId: file.subagentId } : {}) })
        : new CodexRolloutParser(file.sessionId));
    this.parsers.delete(key);
    this.parsers.set(key, parser);
    if (this.parsers.size > MAX_PARSERS) {
      const oldest = this.parsers.keys().next().value;
      if (oldest !== undefined) this.parsers.delete(oldest);
    }
    return parser;
  }

  private line(scan: Scan, text: string): void {
    const claude = scan.file.agent === 'claude';
    // Linhas enormes são resultados de ferramenta: decodificá-las travaria o servidor por nada.
    if (text.length > MAX_PARSE_CHARS) return;
    // A maior parte das linhas do Claude é de outros tipos (anexos, estado do app): nem vale decodificar.
    if (claude && !text.includes('"type":"assistant"') && !text.includes('"type":"user"')) return;
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      return;
    }
    if (claude) {
      // Retomar ou bifurcar uma sessão copia o histórico para um arquivo novo: cada linha conta uma vez só.
      const uuid = isObj(obj) ? str(obj.uuid) : undefined;
      if (uuid && this.seen(scan, uuid)) return;
    }
    let items: Ingest[];
    try {
      items = scan.parser.parse(obj);
    } catch {
      return;
    }
    for (const item of items) this.consume(scan, item);
  }

  private consume(scan: Scan, item: Ingest): void {
    const st = scan.state;
    const ts = item.ts;
    if ('kind' in item) {
      const meta = item.meta;
      if (meta.model) st.model = meta.model;
      let used: TokenUsage | null = null;
      if (meta.usage) used = this.claudeUsage(scan, meta.usage, meta.messageId);
      else if (meta.usageTotal) used = codexUsage(st, meta.usageTotal);
      if (!used) return;
      this.countSession(scan, ts);
      this.active(scan, ts);
      const total = sum(used);
      this.add(scan, ts, 'in', used.input);
      this.add(scan, ts, 'out', used.output);
      this.add(scan, ts, 'cr', used.cacheRead);
      this.add(scan, ts, 'cw', used.cacheWrite);
      this.add(scan, ts, `model:${clip(st.model) || 'desconhecido'}`, total);
      this.add(scan, ts, `project:${clip(st.project) || 'desconhecido'}`, total);
      return;
    }

    if (item.parentSessionId) st.sub = true;
    if (item.cwd && item.project) st.project = item.project;
    if (item.meta?.model) st.model = item.meta.model;
    this.countSession(scan, ts);
    if (item.event === 'prompt') this.add(scan, ts, 'prompts', 1);
    else if (item.event === 'tool_start') {
      this.add(scan, ts, 'tools', 1);
      this.add(scan, ts, `tool:${item.toolCategory}`, 1);
    } else if (item.event === 'error') this.add(scan, ts, 'errors', 1);

    this.active(scan, ts);
    if (NEUTRAL.has(item.event)) return;
    // Erro sem ferramenta (falha da API) encerra o turno; erro de ferramenta não.
    const fatal = item.event === 'error' && !item.toolName && !item.meta?.toolUseId;
    st.busy = !RESTS.has(item.event) && !fatal;
  }

  /** Tokens novos de uma resposta do Claude (a mesma resposta aparece em várias linhas). */
  private claudeUsage(scan: Scan, usage: TokenUsage, id: string | undefined): TokenUsage | null {
    const st = scan.state;
    if (!id) return sum(usage) > 0 ? usage : null;
    if (st.msgId === id) {
      // Linhas seguintes da mesma resposta trazem a contagem atualizada: soma só a diferença.
      const extra = diff(usage, st.msg);
      st.msg = {
        input: Math.max(usage.input, st.msg.input),
        output: Math.max(usage.output, st.msg.output),
        cacheRead: Math.max(usage.cacheRead, st.msg.cacheRead),
        cacheWrite: Math.max(usage.cacheWrite, st.msg.cacheWrite),
      };
      return sum(extra) > 0 ? extra : null;
    }
    if (this.seen(scan, `m:${id}`)) return null;
    st.msgId = id;
    st.msg = { ...usage };
    return sum(usage) > 0 ? usage : null;
  }

  private countSession(scan: Scan, ts: number): void {
    const st = scan.state;
    if (st.counted) return;
    st.counted = true;
    this.add(scan, ts, st.sub ? 'subagents' : 'sessions', 1);
  }

  /** Soma ao tempo ativo o intervalo desde o evento anterior do mesmo turno. */
  private active(scan: Scan, ts: number): void {
    const st = scan.state;
    if (ts <= st.lastTs) return;
    if (st.busy && st.lastTs > 0) {
      this.add(scan, ts, st.sub ? 'subActive' : 'active', Math.min(ts - st.lastTs, ACTIVE_GAP_MS));
    }
    st.lastTs = ts;
  }

  private add(scan: Scan, ts: number, metric: string, value: number): void {
    if (!(value > 0)) return;
    const key = `${this.dayOf(ts)}|${metric}`;
    scan.deltas.set(key, (scan.deltas.get(key) ?? 0) + Math.round(value));
  }

  private dayOf(ts: number): number {
    if (ts < this.dayLo || ts >= this.dayHi) {
      this.dayLo = startOfDay(ts);
      this.dayHi = daysBefore(ts, -1);
    }
    return this.dayLo;
  }

  /** Já contamos esta linha/resposta? Se não, passa a constar (por SEEN_DAYS a partir de hoje). */
  private seen(scan: Scan, token: string): boolean {
    const h = hash64(token);
    if (scan.marks.has(h)) return true;
    if (this.seenStmt.get(h)) return true;
    scan.marks.set(h, this.now());
    return false;
  }

  /** Grava de uma vez contadores, linhas vistas e o ponto de leitura. */
  private flush(scan: Scan, offset: number): void {
    this.db.exec('BEGIN');
    try {
      for (const [key, value] of scan.deltas) {
        const cut = key.indexOf('|');
        this.addStmt.run(Number(key.slice(0, cut)), scan.file.agent, key.slice(cut + 1), value);
      }
      for (const [h, day] of scan.marks) this.markStmt.run(h, day);
      this.cursorStmt.run(scan.key, scan.file.path, offset, this.now(), JSON.stringify(scan.state));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    const changed = scan.deltas.size > 0;
    scan.deltas.clear();
    scan.marks.clear();
    if (changed) {
      this.cached = null;
      // Com a fila vazia é uma sessão ao vivo: avisa já. No histórico, quem avisa é o laço.
      if (this.queue.size === 0) this.emit('change');
    }
  }

  // ───────────────────────── consulta ─────────────────────────

  /** Soma direta em um contador (modo demo). */
  record(agent: AgentKind, ts: number, metric: string, value: number): void {
    if (!(value > 0)) return;
    this.addStmt.run(this.dayOf(ts), agent, metric, Math.round(value));
    this.cached = null;
    this.emit('change');
  }

  summary(now: number = this.now()): UsageResponse {
    const today = startOfDay(now);
    if (!this.cached || this.cached.day !== today) this.cached = { day: today, value: this.compute(now, today) };
    return {
      ...this.cached.value,
      updatedAt: now,
      scan: { pending: this.queue.size, done: this.done, scanning: this.worker !== null && this.queue.size > 0 },
    };
  }

  private compute(now: number, today: number): Omit<UsageResponse, 'updatedAt' | 'scan'> {
    const weekStart = daysBefore(now, 6);
    const allTime = blankTotals();
    const todayTotals = blankTotals();
    const week = blankTotals();
    const byAgent: Record<AgentKind, UsageTotals> = { claude: blankTotals(), codex: blankTotals() };
    const days = new Map<number, UsageDay>();
    for (let i = DAYS_SHOWN - 1; i >= 0; i--) {
      const day = daysBefore(now, i);
      days.set(day, { day, claude: 0, codex: 0, prompts: 0, activeMs: 0 });
    }
    const toolsByCategory = Object.fromEntries(TOOL_CATEGORIES.map((c) => [c, 0])) as Record<ToolCategory, number>;
    const models = new Map<string, number>();
    const projects = new Map<string, number>();
    const tokensByDay = new Map<number, number>();
    const activeDays = new Set<number>();
    let since: number | null = null;

    for (const row of this.db.prepare('SELECT day, agent, metric, value FROM usage_counters').all()) {
      const day = n(row.day);
      const agent: AgentKind = row.agent === 'codex' ? 'codex' : 'claude';
      const metric = String(row.metric);
      const value = n(row.value);
      const colon = metric.indexOf(':');
      if (colon > 0) {
        const kind = metric.slice(0, colon);
        const name = metric.slice(colon + 1);
        if (kind === 'model') models.set(name, (models.get(name) ?? 0) + value);
        else if (kind === 'project') projects.set(name, (projects.get(name) ?? 0) + value);
        else if (kind === 'tool' && name in toolsByCategory) toolsByCategory[name as ToolCategory] += value;
        continue;
      }
      const tokens = addMetric(allTime, metric, value);
      addMetric(byAgent[agent], metric, value);
      if (day === today) addMetric(todayTotals, metric, value);
      if (day >= weekStart) addMetric(week, metric, value);
      if (tokens > 0) tokensByDay.set(day, (tokensByDay.get(day) ?? 0) + tokens);
      if (tokens > 0 || metric === 'prompts') {
        activeDays.add(day);
        if (since === null || day < since) since = day;
      }
      const shown = days.get(day);
      if (shown) {
        if (tokens > 0) shown[agent] += tokens;
        else if (metric === 'prompts') shown.prompts += value;
        else if (metric === 'active') shown.activeMs += value;
      }
    }

    let busiestDay: UsageResponse['busiestDay'] = null;
    for (const [day, tokens] of tokensByDay) {
      if (!busiestDay || tokens > busiestDay.tokens) busiestDay = { day, tokens };
    }
    return {
      since,
      allTime,
      today: todayTotals,
      week,
      byAgent,
      days: [...days.values()],
      toolsByCategory,
      models: top(models),
      projects: top(projects),
      activeDays: activeDays.size,
      busiestDay,
    };
  }

  /** Limpeza periódica: esquece linhas antigas e os arquivos que já não existem. */
  prune(now: number = this.now()): void {
    const cutoff = now - SEEN_DAYS * DAY_MS;
    this.db.prepare('DELETE FROM usage_seen WHERE day < ?').run(cutoff);
    const gone = this.db.prepare('DELETE FROM usage_files WHERE key = ?');
    for (const row of this.db.prepare('SELECT key, path FROM usage_files WHERE updated < ?').all(cutoff)) {
      if (existsSync(String(row.path))) continue;
      gone.run(row.key);
      this.parsers.delete(String(row.key));
    }
  }
}

/**
 * O Claude é seguido pelo caminho (linhas repetidas são reconhecidas uma a
 * uma). O Codex é seguido pelo id da sessão: arquivar uma sessão move o
 * arquivo de pasta e ele não pode ser contado de novo.
 */
function cursorKey(file: TranscriptFile): string {
  return file.agent === 'claude' ? `claude:${file.path}` : `codex:${file.sessionId}`;
}

function blankState(file: TranscriptFile): FileState {
  return {
    sub: Boolean(file.subagentId),
    counted: false,
    model: '',
    project: '',
    busy: false,
    lastTs: 0,
    msgId: '',
    msg: { ...ZERO },
    total: null,
  };
}

function usageOf(raw: unknown): TokenUsage | null {
  if (!isObj(raw)) return null;
  return { input: n(raw.input), output: n(raw.output), cacheRead: n(raw.cacheRead), cacheWrite: n(raw.cacheWrite) };
}

function parseState(raw: unknown, file: TranscriptFile): FileState {
  const blank = blankState(file);
  let obj: unknown;
  try {
    obj = JSON.parse(String(raw));
  } catch {
    return blank;
  }
  if (!isObj(obj)) return blank;
  return {
    sub: obj.sub === true || blank.sub,
    counted: obj.counted === true,
    model: str(obj.model) ?? '',
    project: str(obj.project) ?? '',
    busy: obj.busy === true,
    lastTs: n(obj.lastTs),
    msgId: str(obj.msgId) ?? '',
    msg: usageOf(obj.msg) ?? { ...ZERO },
    total: usageOf(obj.total),
  };
}

/** Tokens novos de uma sessão do Codex, que informa sempre o acumulado. */
function codexUsage(st: FileState, total: TokenUsage): TokenUsage | null {
  const before = st.total;
  // Primeira leitura, ou a contagem recomeçou do zero.
  const used = !before || sum(total) < sum(before) ? total : diff(total, before);
  st.total = { ...total };
  return sum(used) > 0 ? used : null;
}

function clip(name: string): string {
  return name.length > 80 ? name.slice(0, 80) : name;
}
