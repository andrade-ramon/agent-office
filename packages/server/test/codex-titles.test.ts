import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexTitleWatcher } from '../src/codex-titles.js';
import { SessionStore } from '../src/state.js';

describe('CodexTitleWatcher (~/.codex/session_index.jsonl)', () => {
  let dir: string;
  let store: SessionStore;
  const row = (id: string, thread_name: string) => `${JSON.stringify({ id, thread_name, updated_at: new Date().toISOString() })}\n`;
  const prompt = (sessionId: string, parentSessionId?: string) =>
    store.apply({
      agent: 'codex',
      sessionId,
      ...(parentSessionId ? { parentSessionId } : {}),
      cwd: '/repo/api',
      project: 'api',
      event: 'prompt',
      toolCategory: 'other',
      ts: Date.now(),
      source: 'watcher',
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ao-codex-idx-'));
    store = new SessionStore();
  });
  afterEach(() => {
    store.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('aplica o nome da thread às sessões do Codex (a última linha vale)', async () => {
    const file = join(dir, 'session_index.jsonl');
    writeFileSync(file, row('t1', 'Nome antigo') + row('t2', 'Outra thread') + row('t1', 'Verificar relatórios via API') + '{ lixo\n');
    prompt('t1');
    prompt('filho', 't1');
    const watcher = new CodexTitleWatcher(file, store);
    await watcher.poll();
    expect(store.get('codex:t1')?.title).toBe('Verificar relatórios via API');
    expect(store.get('codex:filho')?.title).toBeUndefined();

    // sessão que aparece depois e thread renomeada
    prompt('t2');
    await new Promise((r) => setTimeout(r, 15));
    appendFileSync(file, row('t1', 'Relatórios: investigar execução 387'));
    await watcher.poll();
    expect(store.get('codex:t2')?.title).toBe('Outra thread');
    expect(store.get('codex:t1')?.title).toBe('Relatórios: investigar execução 387');
  });

  it('tolera a ausência do índice', async () => {
    prompt('t1');
    await expect(new CodexTitleWatcher(join(dir, 'nao-existe.jsonl'), store).poll()).resolves.toBeUndefined();
    expect(store.get('codex:t1')?.title).toBeUndefined();
  });
});
