import { execFile } from 'node:child_process';
import {
  RemoteSessionWatcher,
  remoteSessionId,
  type RemoteSession,
  type RemoteSettings,
  type RemoteState,
  type RemoteStatus,
} from './remote-sessions.js';
import type { SessionStore } from './state.js';
import { isObj, num, parseTs, str } from './util.js';

export type CodexCloudSettings = RemoteSettings;

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

export function cloudSessionId(taskId: string): string {
  return remoteSessionId(taskId);
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

export type CodexCloudStatus = RemoteStatus;

const STATE: Record<CloudTaskStatus, RemoteState> = { pending: 'running', ready: 'done', applied: 'done', error: 'error' };

function toRemote(task: CloudTask): RemoteSession {
  return {
    id: task.id,
    state: STATE[task.status],
    updatedAt: task.updatedAt,
    ...(task.title ? { title: task.title } : {}),
    ...(task.url ? { url: task.url } : {}),
    ...(task.environment ? { project: task.environment } : {}),
    ...(task.changes ? { changes: task.changes } : {}),
  };
}

/** Tarefas do Codex Cloud, consultadas com `codex cloud list --json`. */
export class CodexCloudWatcher extends RemoteSessionWatcher {
  constructor(
    store: SessionStore,
    settings: () => CodexCloudSettings,
    list: ListCloudTasks = runCodexCloudList,
    now: () => number = Date.now,
    log: (msg: string) => void = () => undefined,
  ) {
    super(
      store,
      settings,
      {
        agent: 'codex',
        entrypoint: CLOUD_ENTRYPOINT,
        minEverySec: 10,
        list: async (bin, at) => parseCloudTasks(await list(bin), at).map(toRemote),
      },
      now,
      log,
    );
  }
}
