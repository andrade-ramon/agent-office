import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeProcessWatcher } from '../src/claude-procs.js';
import { SessionStore } from '../src/state.js';

/** PID que certamente não existe. */
const DEAD_PID = 2 ** 22 + 12345;

describe('ClaudeProcessWatcher (~/.claude/sessions/<pid>.json)', () => {
  let dir: string;
  let store: SessionStore;
  const now = Date.now();

  const write = (pid: number, data: Record<string, unknown>) =>
    writeFileSync(
      join(dir, `${pid}.json`),
      JSON.stringify({ pid, cwd: '/Users/ana/loja', startedAt: now - 60_000, entrypoint: 'cli', statusUpdatedAt: now - 30_000, ...data }),
    );

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ao-procs-'));
    store = new SessionStore();
  });
  afterEach(() => {
    store.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('cria sessões para processos vivos e as marca como vivas', async () => {
    write(process.pid, { sessionId: 'viva', status: 'idle' });
    write(DEAD_PID, { sessionId: 'morta', status: 'busy' });
    const watcher = new ClaudeProcessWatcher(dir, store);
    await watcher.poll(now);
    expect(store.get('claude:viva')).toMatchObject({
      status: 'done',
      alive: true,
      pid: process.pid,
      project: 'loja',
      entrypoint: 'cli',
    });
    expect(store.get('claude:morta')).toBeUndefined();
  });

  it('encerra a sessão quando o arquivo do processo some', async () => {
    write(process.pid, { sessionId: 'viva', status: 'busy' });
    const watcher = new ClaudeProcessWatcher(dir, store);
    await watcher.poll(now);
    expect(store.get('claude:viva')?.status).toBe('thinking');
    rmSync(join(dir, `${process.pid}.json`));
    await watcher.poll(now + 3000);
    expect(store.get('claude:viva')).toMatchObject({ status: 'ended', alive: false });
  });

  it('na partida, encerra sessões reconstruídas cujo processo não existe mais', async () => {
    const base = { agent: 'claude' as const, cwd: '/x', project: 'x', toolCategory: 'other' as const, source: 'watcher' as const };
    store.apply({ ...base, sessionId: 'antiga', event: 'stop', ts: now - 120_000 }, { replay: true });
    store.apply({ ...base, sessionId: 'viva', event: 'prompt', ts: now - 5000 }, { replay: true });
    store.apply({ ...base, sessionId: 'filha', parentSessionId: 'viva', event: 'subagent_start', ts: now - 4000 }, { replay: true });
    store.apply({ ...base, agent: 'codex', sessionId: 'codex-1', event: 'prompt', ts: now - 5000 }, { replay: true });
    write(process.pid, { sessionId: 'viva', status: 'busy' });

    const watcher = new ClaudeProcessWatcher(dir, store);
    await watcher.poll(now);
    expect(store.get('claude:antiga')?.status).toBe('ended');
    expect(store.get('claude:viva')).toMatchObject({ status: 'thinking', alive: true });
    expect(store.get('claude:filha')?.status).toBe('thinking');
    expect(store.get('codex:codex-1')?.status).toBe('thinking');

    // nas varreduras seguintes, sessões novas sem arquivo de processo não são tocadas
    store.apply({ ...base, sessionId: 'nova', event: 'prompt', ts: now + 1000 });
    await watcher.poll(now + 3000);
    expect(store.get('claude:nova')?.status).toBe('thinking');
  });

  it('reconcilia com o status do processo quando o transcript não mostrou o fim do turno', async () => {
    const base = { agent: 'claude' as const, sessionId: 'viva', cwd: '/x', project: 'x', toolCategory: 'other' as const, source: 'watcher' as const };
    write(process.pid, { sessionId: 'viva', status: 'busy', statusUpdatedAt: now - 60_000 });
    const watcher = new ClaudeProcessWatcher(dir, store);
    store.apply({ ...base, event: 'prompt', ts: now - 60_000 });
    await watcher.poll(now - 50_000);
    expect(store.get('claude:viva')?.status).toBe('thinking');

    // o processo ficou ocioso (ex.: usuário interrompeu) e nada mais foi escrito
    write(process.pid, { sessionId: 'viva', status: 'idle', statusUpdatedAt: now - 20_000 });
    await new Promise((r) => setTimeout(r, 15)); // garante mtime diferente
    writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'viva', cwd: '/x', status: 'idle', statusUpdatedAt: now - 20_000 }));
    await watcher.poll(now);
    expect(store.get('claude:viva')?.status).toBe('done');

    // e voltou a trabalhar
    await new Promise((r) => setTimeout(r, 15));
    writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'viva', cwd: '/x', status: 'busy', statusUpdatedAt: now + 10_000 }));
    await watcher.poll(now + 11_000);
    expect(store.get('claude:viva')?.status).toBe('thinking');
  });

  it('status "waiting" vira pedido de atenção e "busy" devolve ao trabalho', async () => {
    const base = { agent: 'claude' as const, sessionId: 'viva', cwd: '/x', project: 'x', source: 'watcher' as const };
    const file = join(dir, `${process.pid}.json`);
    const put = async (data: Record<string, unknown>) => {
      await new Promise((r) => setTimeout(r, 15));
      writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId: 'viva', cwd: '/x', ...data }));
    };
    const events: string[] = [];
    store.on('event', (_k, e) => events.push(`${e.event}:${e.source}`));

    await put({ status: 'busy', statusUpdatedAt: now - 10_000 });
    const watcher = new ClaudeProcessWatcher(dir, store);
    await watcher.poll(now - 9000);
    store.apply({ ...base, event: 'tool_start', toolName: 'Bash', toolCategory: 'bash', ts: now - 5000, meta: { toolUseId: 't1' } });

    await put({ status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: now - 4000 });
    await watcher.poll(now - 3000);
    expect(store.get('claude:viva')).toMatchObject({ status: 'permission_wait', toolName: 'Bash', toolCategory: 'bash' });
    expect(events).toContain('permission_wait:system');

    // o usuário aprovou: o processo volta a "busy" e a ferramenta continua rodando
    await put({ status: 'busy', statusUpdatedAt: now - 1000 });
    await watcher.poll(now);
    expect(store.get('claude:viva')).toMatchObject({ status: 'working', toolName: 'Bash' });

    // pergunta ao usuário (sem ser permissão) e, depois, turno encerrado
    await put({ status: 'waiting', waitingFor: 'input', statusUpdatedAt: now + 1000 });
    await watcher.poll(now + 2000);
    expect(store.get('claude:viva')?.status).toBe('waiting_input');
    await put({ status: 'idle', statusUpdatedAt: now + 20_000 });
    await watcher.poll(now + 30_000);
    expect(store.get('claude:viva')?.status).toBe('done');
  });

  it('troca de sessão no mesmo processo encerra a anterior', async () => {
    write(process.pid, { sessionId: 's1', status: 'idle' });
    const watcher = new ClaudeProcessWatcher(dir, store);
    await watcher.poll(now);
    await new Promise((r) => setTimeout(r, 15));
    write(process.pid, { sessionId: 's2', status: 'busy', statusUpdatedAt: now + 1000 });
    await watcher.poll(now + 3000);
    expect(store.get('claude:s1')?.status).toBe('ended');
    expect(store.get('claude:s2')).toMatchObject({ status: 'thinking', alive: true });
  });

  it('tolera diretório inexistente e arquivos inválidos', async () => {
    const missing = new ClaudeProcessWatcher(join(dir, 'nao-existe'), store);
    await expect(missing.poll(now)).resolves.toBeUndefined();
    writeFileSync(join(dir, '123.json'), '{ lixo');
    writeFileSync(join(dir, 'notas.txt'), 'x');
    const watcher = new ClaudeProcessWatcher(dir, store);
    await expect(watcher.poll(now)).resolves.toBeUndefined();
    expect(store.size).toBe(0);
  });
});
