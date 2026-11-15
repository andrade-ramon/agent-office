import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexCloudWatcher, parseCloudTasks, type CodexCloudSettings } from '../src/codex-cloud.js';
import { codexCloudReader } from '../src/config.js';
import type { SessionState } from '../src/schema.js';
import { SessionStore } from '../src/state.js';

const T0 = 1_700_000_000_000;
const iso = (ms: number): string => new Date(ms).toISOString();

interface RawTask {
  id: string;
  status: string;
  updated_at: string;
  title?: string;
  url?: string;
  environment_label?: string | null;
  summary?: { files_changed: number; lines_added: number; lines_removed: number };
}

const task = (id: string, status: string, updatedAt: number, extra: Partial<RawTask> = {}): RawTask => ({
  id,
  status,
  updated_at: iso(updatedAt),
  title: `Tarefa ${id}`,
  url: `https://chatgpt.com/codex/tasks/${id}`,
  environment_label: 'sousmile/loja',
  summary: { files_changed: 0, lines_added: 0, lines_removed: 0 },
  ...extra,
});

describe('parseCloudTasks', () => {
  it('lê a saída de "codex cloud list --json" e descarta o que não entende', () => {
    const json = JSON.stringify({
      tasks: [
        task('t1', 'pending', T0 - 5000),
        task('t2', 'ready', T0 - 60_000, { summary: { files_changed: 3, lines_added: 120, lines_removed: 14 } }),
        task('t3', 'desconhecido', T0),
        { status: 'ready' },
        task('t4', 'error', T0 + 999_999, { url: 'javascript:alert(1)', environment_label: null, title: '' }),
      ],
      cursor: null,
    });
    expect(parseCloudTasks(json, T0)).toEqual([
      { id: 't1', status: 'pending', updatedAt: T0 - 5000, title: 'Tarefa t1', url: 'https://chatgpt.com/codex/tasks/t1', environment: 'sousmile/loja' },
      {
        id: 't2',
        status: 'ready',
        updatedAt: T0 - 60_000,
        title: 'Tarefa t2',
        url: 'https://chatgpt.com/codex/tasks/t2',
        environment: 'sousmile/loja',
        changes: { files: 3, added: 120, removed: 14 },
      },
      // data no futuro é limitada a agora; link que não é https é descartado
      { id: 't4', status: 'error', updatedAt: T0 },
    ]);
    expect(parseCloudTasks('{"tasks":[],"cursor":null}', T0)).toEqual([]);
    expect(() => parseCloudTasks('não é json', T0)).toThrow();
  });
});

describe('CodexCloudWatcher', () => {
  let store: SessionStore;
  let now: number;
  let settings: CodexCloudSettings;
  let tasks: RawTask[];
  let calls: string[];
  let fail: string | null;
  let watcher: CodexCloudWatcher;

  const get = (id: string): SessionState | undefined => store.get(`codex:cloud-${id}`);
  const poll = async (advanceMs = 30_000): Promise<boolean> => {
    now += advanceMs;
    return watcher.tick();
  };

  beforeEach(() => {
    store = new SessionStore();
    now = T0;
    settings = { enabled: true, bin: '/fake/codex', everySec: 30 };
    tasks = [];
    calls = [];
    fail = null;
    watcher = new CodexCloudWatcher(
      store,
      () => settings,
      async (bin) => {
        calls.push(bin);
        if (fail) throw new Error(fail);
        return JSON.stringify({ tasks, cursor: null });
      },
      () => now,
    );
  });
  afterEach(() => store.dispose());

  it('tarefa rodando vira sessão na nuvem e conclui quando fica pronta', async () => {
    tasks = [task('a', 'pending', T0 - 20_000)];
    expect(await watcher.tick()).toBe(true);
    expect(calls).toEqual(['/fake/codex']);
    expect(get('a')).toMatchObject({
      agent: 'codex',
      status: 'working',
      remote: true,
      alive: true,
      entrypoint: 'Codex Cloud',
      project: 'sousmile/loja',
      title: 'Tarefa a',
      url: 'https://chatgpt.com/codex/tasks/a',
      cwd: '',
      statusSince: T0 - 20_000,
    });
    expect(watcher.status()).toMatchObject({ enabled: true, running: 1, lastOkAt: T0, error: null });

    // respeita o intervalo entre consultas
    expect(await poll(5000)).toBe(false);
    expect(calls).toHaveLength(1);

    // uma tarefa longa não fica ociosa nem expira enquanto roda
    await poll(25_000);
    store.tick(now + 45 * 60_000);
    expect(get('a')?.status).toBe('working');

    tasks = [task('a', 'ready', now, { title: 'Corrigir frete', summary: { files_changed: 2, lines_added: 40, lines_removed: 5 } })];
    await poll();
    expect(get('a')).toMatchObject({
      status: 'done',
      alive: false,
      title: 'Corrigir frete',
      changes: { files: 2, added: 40, removed: 5 },
      toolName: null,
    });
    expect(watcher.status().running).toBe(0);

    // depois de concluída segue o fluxo normal: ociosa e, por fim, vai embora
    store.tick(now + 6 * 60_000);
    expect(get('a')?.status).toBe('idle');
    store.tick(now + 31 * 60_000);
    expect(get('a')?.status).toBe('ended');
    // continua na listagem como "ready": não volta para o escritório
    await poll();
    expect(get('a')?.status).toBe('ended');
  });

  it('ignora tarefas antigas já concluídas, mostra as recentes e marca erro', async () => {
    tasks = [
      task('velha', 'ready', T0 - 3 * 60 * 60_000),
      task('recente', 'applied', T0 - 2 * 60_000),
      task('falhou', 'error', T0 - 60_000),
    ];
    await watcher.tick();
    expect(get('velha')).toBeUndefined();
    expect(get('recente')).toMatchObject({ status: 'done', remote: true, lastActivityAt: T0 - 2 * 60_000 });
    expect(get('falhou')).toMatchObject({ status: 'error', remote: true });

    // a tarefa antiga recebe um novo pedido e volta a rodar
    tasks = [task('velha', 'pending', T0 + 20_000), ...tasks.slice(1)];
    await poll();
    expect(get('velha')).toMatchObject({ status: 'working', alive: true });
  });

  it('nova rodada na mesma tarefa volta a trabalhar; tarefa que some sai do escritório', async () => {
    tasks = [task('a', 'pending', T0)];
    await watcher.tick();
    tasks = [task('a', 'ready', T0 + 30_000)];
    await poll();
    expect(get('a')?.status).toBe('done');
    tasks = [task('a', 'pending', T0 + 60_000)];
    await poll();
    expect(get('a')).toMatchObject({ status: 'working', alive: true, counts: { prompts: 1 } });

    tasks = [];
    await poll();
    expect(get('a')?.status).toBe('ended');
    expect(watcher.status().running).toBe(0);
  });

  it('falha na consulta é registrada sem derrubar as sessões; desligar limpa tudo', async () => {
    tasks = [task('a', 'pending', T0)];
    await watcher.tick();
    fail = 'Not signed in';
    await poll();
    expect(watcher.status()).toMatchObject({ enabled: true, running: 1, error: 'Not signed in', lastOkAt: T0 });
    expect(get('a')?.status).toBe('working');
    fail = null;
    await poll();
    expect(watcher.status().error).toBeNull();

    settings = { ...settings, enabled: false };
    const before = calls.length;
    expect(await poll()).toBe(false);
    expect(calls).toHaveLength(before);
    expect(get('a')?.status).toBe('ended');
    expect(watcher.status()).toEqual({ enabled: false, running: 0, lastOkAt: null, error: null });

    // sem o caminho da CLI não há o que consultar
    settings = { enabled: true, bin: '', everySec: 30 };
    expect(await poll()).toBe(false);
  });

  it('respeita "titles: false"', async () => {
    store.dispose();
    store = new SessionStore({ titles: false });
    watcher = new CodexCloudWatcher(store, () => settings, async () => JSON.stringify({ tasks, cursor: null }), () => now);
    tasks = [task('a', 'pending', T0)];
    await watcher.tick();
    expect(get('a')).toMatchObject({ status: 'working', remote: true });
    expect(get('a')?.title).toBeUndefined();
  });
});

describe('codexCloudReader', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ao-cloud-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('desligado por padrão; lê a seção codexCloud', () => {
    const read = codexCloudReader(dir);
    expect(read()).toEqual({ enabled: false, bin: '', everySec: 30 });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 4747, codexCloud: { enabled: true, bin: '/x/codex', everySec: 60 } }));
    expect(read()).toEqual({ enabled: true, bin: '/x/codex', everySec: 60 });
  });
});
