import { execFile } from 'node:child_process';
import { sessionKey, type EventMeta, type EventType, type NormalizedEvent } from './schema.js';
import type { SessionStore } from './state.js';
import { isObj, num, parseTs, str } from './util.js';

export interface CodexCloudSettings {
  enabled: boolean;
  /** Caminho da CLI do Codex (gravado por `agent-office cloud on`). */
  bin: string;
  /** Intervalo entre consultas, em segundos. */
  everySec: number;
}

export const DEFAULT_CODEX_CLOUD: CodexCloudSettings = { enabled: false, bin: '', everySec: 30 };

/** Estados que `codex cloud list --json` devolve. */
export type CloudTaskStatus = 'pending' | 'ready' | 'applied' | 'error';

export interface CloudTask {
  id: string;
  status: CloudTaskStatus;
  updatedAt: number;
  title?: string;
  url?: string;
  /** Nome do ambiente (normalmente o repositório). */
  environment?: string;
  changes?: { files: number; added: number; removed: number };
}

/** Roda a listagem e devolve o JSON bruto (injetável nos testes). */
export type ListCloudTasks = (bin: string) => Promise<string>;

export const CLOUD_ENTRYPOINT = 'Codex Cloud';
const STATUSES: ReadonlySet<string> = new Set(['pending', 'ready', 'applied', 'error']);
/** Tarefas já concluídas só aparecem se terminaram há pouco. */
const RECENT_MS = 10 * 60_000;

export function cloudSessionId(taskId: string): string {
  return `cloud-${taskId}`;
}

/** Lê a saída de `codex cloud list --json`. Só metadados: id, título, estado, ambiente e contagens. */
export function parseCloudTasks(json: string, now: number = Date.now()): CloudTask[] {
  const raw: unknown = JSON.parse(json);
  const list = isObj(raw) && Array.isArray(raw.tasks) ? raw.tasks : [];
  const tasks: CloudTask[] = [];
  for (const item of list) {
    if (!isObj(item)) continue;
    const id = str(item.id);
    const status = str(item.status);
    if (!id || !status || !STATUSES.has(status)) continue;
    const url = str(item.url);
    const title = str(item.title);
    const environment = str(item.environment_label);
    const summary = isObj(item.summary) ? item.summary : {};
    const files = num(summary.files_changed) ?? 0;
    const added = num(summary.lines_added) ?? 0;
    const removed = num(summary.lines_removed) ?? 0;
    tasks.push({
      id,
      status: status as CloudTaskStatus,
      updatedAt: Math.min(now, parseTs(item.updated_at, now)),
      ...(title ? { title } : {}),
      ...(url && /^https:\/\//i.test(url) ? { url } : {}),
      ...(environment ? { environment } : {}),
      ...(files || added || removed ? { changes: { files, added, removed } } : {}),
    });
  }
  return tasks;
}

export const runCodexCloudList: ListCloudTasks = (bin) =>
  new Promise((resolve, reject) => {
    execFile(
      bin,
      ['cloud', 'list', '--json', '--limit', '20'],
      { timeout: 20_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error((String(stderr).trim().split('\n').pop() || err.message).slice(0, 200)));
        else resolve(String(stdout));
      },
    );
  });

export interface CodexCloudStatus {
  enabled: boolean;
  /** Tarefas rodando na nuvem agora. */
  running: number;
  lastOkAt: number | null;
  error: string | null;
}

/**
 * Sessões do Codex que rodam na nuvem: não há hooks nem arquivos locais, então
 * o servidor consulta a própria CLI do Codex de tempos em tempos e transforma
 * cada tarefa em uma sessão. Opcional e desligado por padrão — é a única fonte
 * que faz uma requisição para fora (à sua conta, pela CLI oficial).
 */
export class CodexCloudWatcher {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private lastPollAt = 0;
  private lastOkAt: number | null = null;
  private error: string | null = null;
  /** Último estado visto de cada tarefa que virou sessão. */
  private readonly tracked = new Map<string, CloudTaskStatus>();
  /** Tarefas antigas, já concluídas quando as vimos pela primeira vez. */
  private readonly skipped = new Set<string>();

  constructor(
    private readonly store: SessionStore,
    private readonly settings: () => CodexCloudSettings,
    private readonly list: ListCloudTasks = runCodexCloudList,
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

  status(): CodexCloudStatus {
    let running = 0;
    for (const s of this.tracked.values()) if (s === 'pending') running++;
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
    if (this.now() - this.lastPollAt < Math.max(10, settings.everySec) * 1000) return false;
    this.polling = true;
    this.lastPollAt = this.now();
    try {
      this.apply(parseCloudTasks(await this.list(settings.bin), this.now()));
      this.lastOkAt = this.now();
      if (this.error) this.log('codex cloud: consulta voltou a funcionar');
      this.error = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== this.error) this.log(`codex cloud: ${message}`);
      this.error = message;
    } finally {
      this.polling = false;
    }
    return true;
  }

  private active(settings: CodexCloudSettings): boolean {
    return settings.enabled && settings.bin.length > 0;
  }

  /** Desligado: as sessões da nuvem saem do escritório. */
  private clear(reason: string): void {
    for (const id of this.tracked.keys()) this.store.end(sessionKey('codex', cloudSessionId(id)), this.now(), reason);
    this.tracked.clear();
    this.skipped.clear();
    this.lastPollAt = 0;
    this.lastOkAt = null;
    this.error = null;
  }

  private apply(tasks: CloudTask[]): void {
    const now = this.now();
    const listed = new Set<string>();
    for (const task of tasks) {
      listed.add(task.id);
      const before = this.tracked.get(task.id);
      if (before === undefined) {
        if (this.skipped.has(task.id) && task.status !== 'pending') continue;
        if (task.status !== 'pending' && now - task.updatedAt > RECENT_MS) {
          this.skipped.add(task.id);
          continue;
        }
        this.skipped.delete(task.id);
        this.emit(task, 'session_start', task.updatedAt);
        if (task.status === 'pending') this.emit(task, 'tool_start', task.updatedAt);
        else this.finish(task, task.updatedAt);
      } else if (before !== task.status) {
        if (task.status === 'pending') {
          // Nova rodada na mesma tarefa (um pedido de ajuste, por exemplo).
          this.emit(task, 'prompt', now);
          this.emit(task, 'tool_start', now);
        } else if (before === 'pending') {
          this.finish(task, now);
        }
      }
      // Título e contagens em dia; enquanto roda, a sessão não expira por inatividade.
      this.store.apply({
        kind: 'meta',
        agent: 'codex',
        sessionId: cloudSessionId(task.id),
        ts: now,
        meta: { ...this.meta(task), alive: task.status === 'pending' },
      });
      this.tracked.set(task.id, task.status);
    }
    // Sumiu da listagem (apagada ou arquivada): sai do escritório.
    for (const id of [...this.tracked.keys()]) {
      if (listed.has(id)) continue;
      this.store.end(sessionKey('codex', cloudSessionId(id)), now, 'cloud_gone');
      this.tracked.delete(id);
    }
  }

  private finish(task: CloudTask, ts: number): void {
    this.emit(task, task.status === 'error' ? 'error' : 'stop', ts);
  }

  private meta(task: CloudTask): EventMeta {
    return {
      entrypoint: CLOUD_ENTRYPOINT,
      remote: true,
      ...(task.title ? { title: task.title } : {}),
      ...(task.url ? { url: task.url } : {}),
      ...(task.changes ? { changes: task.changes } : {}),
    };
  }

  private emit(task: CloudTask, event: EventType, ts: number): void {
    const ev: NormalizedEvent = {
      agent: 'codex',
      sessionId: cloudSessionId(task.id),
      cwd: '',
      project: task.environment ?? CLOUD_ENTRYPOINT,
      event,
      toolCategory: 'other',
      ts,
      source: 'cloud',
      ...(event === 'tool_start' ? { toolName: CLOUD_ENTRYPOINT } : {}),
      meta: this.meta(task),
    };
    this.store.apply(ev);
  }
}
