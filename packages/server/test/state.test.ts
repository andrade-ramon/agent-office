import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventSource, EventType, NormalizedEvent, ToolCategory } from '../src/schema.js';
import { SessionStore } from '../src/state.js';

const T0 = 1_700_000_000_000;

function ev(
  event: EventType,
  ts: number,
  extra: Partial<NormalizedEvent> & { id?: string; tool?: [string, ToolCategory] } = {},
): NormalizedEvent {
  const { id, tool, ...rest } = extra;
  return {
    agent: 'claude',
    sessionId: 's1',
    cwd: '/repo/loja',
    project: 'loja',
    event,
    toolCategory: tool?.[1] ?? 'other',
    ts,
    source: 'hook' as EventSource,
    ...(tool ? { toolName: tool[0] } : {}),
    ...(id ? { meta: { toolUseId: id } } : {}),
    ...rest,
  };
}

describe('SessionStore', () => {
  let store: SessionStore;
  beforeEach(() => {
    store = new SessionStore({ idleAfterMs: 5 * 60_000, endAfterMs: 30 * 60_000, childEndAfterMs: 90_000, purgeAfterMs: 60_000 });
  });
  afterEach(() => store.dispose());

  const status = (key = 'claude:s1') => store.get(key)?.status;

  it('percorre a máquina de estados de um turno', () => {
    store.apply(ev('session_start', T0));
    expect(status()).toBe('starting');
    store.apply(ev('prompt', T0 + 1000));
    expect(status()).toBe('thinking');
    store.apply(ev('tool_start', T0 + 2000, { id: 't1', tool: ['Edit', 'edit'] }));
    expect(store.get('claude:s1')).toMatchObject({ status: 'working', toolCategory: 'edit', toolName: 'Edit' });
    store.apply(ev('tool_end', T0 + 3000, { id: 't1', tool: ['Edit', 'edit'] }));
    expect(store.get('claude:s1')).toMatchObject({ status: 'thinking', toolCategory: null });
    store.apply(ev('permission_wait', T0 + 4000, { tool: ['Bash', 'bash'] }));
    expect(store.get('claude:s1')).toMatchObject({ status: 'permission_wait', toolCategory: 'bash' });
    store.apply(ev('stop', T0 + 5000));
    expect(status()).toBe('done');
    store.apply(ev('waiting_input', T0 + 65_000));
    expect(status()).toBe('waiting_input');
    store.apply(ev('session_end', T0 + 70_000));
    expect(store.get('claude:s1')).toMatchObject({ status: 'ended', endedAt: T0 + 70_000 });
    expect(store.get('claude:s1')?.counts).toEqual({ prompts: 1, tools: 1, errors: 0 });
  });

  it('mantém "working" enquanto houver ferramentas paralelas abertas', () => {
    store.apply(ev('prompt', T0));
    store.apply(ev('tool_start', T0 + 1, { id: 'a', tool: ['Read', 'read'] }));
    store.apply(ev('tool_start', T0 + 2, { id: 'b', tool: ['Grep', 'search'] }));
    expect(store.get('claude:s1')?.toolCategory).toBe('search');
    store.apply(ev('tool_end', T0 + 3, { id: 'b' }));
    expect(store.get('claude:s1')).toMatchObject({ status: 'working', toolCategory: 'read' });
    store.apply(ev('tool_end', T0 + 4, { id: 'a' }));
    expect(status()).toBe('thinking');
  });

  it('deduplica o mesmo evento vindo do hook e do watcher', () => {
    const seen: string[] = [];
    store.on('event', (_k, e) => seen.push(`${e.event}:${e.source}`));
    store.apply(ev('prompt', T0, { source: 'hook' }));
    store.apply(ev('prompt', T0 + 300, { source: 'watcher' }));
    store.apply(ev('tool_start', T0 + 1000, { id: 't1', tool: ['Bash', 'bash'], source: 'hook' }));
    store.apply(ev('tool_start', T0 + 1100, { id: 't1', tool: ['Bash', 'bash'], source: 'watcher' }));
    store.apply(ev('tool_end', T0 + 2000, { id: 't1', source: 'hook' }));
    store.apply(ev('tool_end', T0 + 2100, { id: 't1', source: 'watcher' }));
    store.apply(ev('stop', T0 + 3000, { source: 'watcher' }));
    store.apply(ev('stop', T0 + 3200, { source: 'hook' }));
    expect(seen).toEqual(['prompt:hook', 'tool_start:hook', 'tool_end:hook', 'stop:watcher']);
    expect(store.get('claude:s1')).toMatchObject({
      status: 'done',
      counts: { prompts: 1, tools: 1, errors: 0 },
      sources: { hook: true, watcher: true },
    });
  });

  it('não fica preso em "working" quando o fim chega antes do início (hooks assíncronos)', () => {
    store.apply(ev('prompt', T0));
    store.apply(ev('tool_end', T0 + 20, { id: 't1', tool: ['Read', 'read'] }));
    store.apply(ev('tool_start', T0 + 10, { id: 't1', tool: ['Read', 'read'] }));
    expect(status()).toBe('thinking');
    expect(store.get('claude:s1')?.counts.tools).toBe(1);
  });

  it('eventos atrasados entram no histórico mas não mudam o status', () => {
    store.apply(ev('prompt', T0));
    store.apply(ev('stop', T0 + 60_000));
    store.apply(ev('tool_start', T0 + 10_000, { id: 'old', tool: ['Bash', 'bash'], source: 'watcher' }));
    expect(status()).toBe('done');
    expect(store.get('claude:s1')?.counts.tools).toBe(1);
  });

  it('erro de ferramenta é transitório; erro fatal muda o status', () => {
    store.apply(ev('prompt', T0));
    store.apply(ev('tool_start', T0 + 1, { id: 't1', tool: ['Bash', 'bash'] }));
    store.apply(ev('error', T0 + 2, { id: 't1', tool: ['Bash', 'bash'] }));
    expect(store.get('claude:s1')).toMatchObject({ status: 'thinking', lastErrorAt: T0 + 2 });
    store.apply(ev('error', T0 + 5000, { meta: { reason: 'stop_failure' } }));
    expect(status()).toBe('error');
    expect(store.get('claude:s1')?.counts.errors).toBe(2);
  });

  it('cria subagentes ligados ao pai e conta os ativos', () => {
    store.apply(ev('prompt', T0));
    store.apply(ev('subagent_start', T0 + 1, { sessionId: 'a1', parentSessionId: 's1', meta: { agentType: 'Explore' } }));
    store.apply(ev('subagent_start', T0 + 2, { sessionId: 'a2', parentSessionId: 's1' }));
    expect(store.get('claude:a1')).toMatchObject({ parentKey: 'claude:s1', status: 'thinking', label: 'Explore' });
    expect(store.get('claude:s1')?.subagents).toBe(2);
    store.apply(ev('tool_start', T0 + 3, { sessionId: 'a1', parentSessionId: 's1', id: 'x', tool: ['Grep', 'search'] }));
    expect(store.get('claude:a1')).toMatchObject({ status: 'working', toolCategory: 'search' });
    expect(status()).toBe('thinking');
    store.apply(ev('subagent_stop', T0 + 4, { sessionId: 'a1', parentSessionId: 's1' }));
    expect(store.get('claude:a1')?.status).toBe('ended');
    expect(store.get('claude:s1')?.subagents).toBe(1);
  });

  it('aplica idle, encerramento e remoção por tempo', () => {
    const removed: string[] = [];
    store.on('remove', (k) => removed.push(k));
    store.apply(ev('prompt', T0));
    store.tick(T0 + 4 * 60_000);
    expect(status()).toBe('thinking');
    store.tick(T0 + 6 * 60_000);
    expect(status()).toBe('idle');
    store.tick(T0 + 31 * 60_000);
    expect(status()).toBe('ended');
    store.tick(T0 + 33 * 60_000);
    expect(store.get('claude:s1')).toBeUndefined();
    expect(removed).toEqual(['claude:s1']);
  });

  it('quem espera o usuário não vira idle; processo vivo não é encerrado por tempo', () => {
    store.apply(ev('permission_wait', T0));
    store.tick(T0 + 10 * 60_000);
    expect(status()).toBe('permission_wait');

    store.apply(ev('stop', T0, { sessionId: 's2' }));
    store.apply({ kind: 'meta', agent: 'claude', sessionId: 's2', ts: T0, meta: { alive: true, pid: 123 } });
    store.tick(T0 + 3 * 60 * 60_000);
    expect(store.get('claude:s2')).toMatchObject({ status: 'idle', alive: true, pid: 123 });
  });

  it('encerra subagentes parados e os filhos de sessões encerradas', () => {
    store.apply(ev('prompt', T0));
    store.apply(ev('subagent_start', T0, { agent: 'codex', sessionId: 'c-child', parentSessionId: 'c-root' }));
    store.apply(ev('stop', T0 + 1000, { agent: 'codex', sessionId: 'c-child', parentSessionId: 'c-root' }));
    store.tick(T0 + 1000 + 91_000);
    expect(store.get('codex:c-child')?.status).toBe('ended');

    // subagente apenas quieto (gerando uma resposta longa) não é encerrado
    store.apply(ev('subagent_start', T0, { sessionId: 'lento', parentSessionId: 's1' }));
    store.tick(T0 + 8 * 60_000);
    expect(store.get('claude:lento')?.status).toBe('idle');

    store.apply(ev('subagent_start', T0, { sessionId: 'a1', parentSessionId: 's1' }));
    store.apply(ev('session_end', T0 + 10, {}));
    store.tick(T0 + 20);
    expect(store.get('claude:a1')?.status).toBe('ended');
  });

  it('uma sessão encerrada revive com atividade nova, mas não com um fim de turno atrasado', () => {
    store.apply(ev('prompt', T0));
    store.apply(ev('session_end', T0 + 1));
    // `codex exec`: o SessionEnd do hook chega antes do task_complete lido do arquivo
    store.apply(ev('stop', T0 + 500, { source: 'watcher' }));
    store.apply(ev('tool_end', T0 + 600, { id: 'x', source: 'watcher' }));
    expect(store.get('claude:s1')).toMatchObject({ status: 'ended', endedAt: T0 + 1 });
    store.apply(ev('prompt', T0 + 10_000));
    expect(store.get('claude:s1')).toMatchObject({ status: 'thinking' });
    expect(store.get('claude:s1')?.endedAt).toBeUndefined();
  });

  it('calcula o uso de contexto e emite atualizações agrupadas', () => {
    const updates: string[] = [];
    store.on('session', (s) => updates.push(s.status));
    store.apply(ev('prompt', T0));
    store.apply({ kind: 'meta', agent: 'claude', sessionId: 's1', ts: T0, meta: { contextTokens: 50_000 } });
    store.apply(ev('stop', T0 + 1));
    expect(updates).toEqual([]);
    store.flush();
    expect(updates).toEqual(['done']);
    expect(store.get('claude:s1')?.context).toEqual({ tokens: 50_000, window: 200_000, pct: 0.25 });
  });

  it('com hooks ativos, ignora a ferramenta-invólucro vista pelo watcher (code mode do Codex)', () => {
    const cx = (event: EventType, ts: number, extra: Parameters<typeof ev>[2] = {}) =>
      ev(event, ts, { agent: 'codex', sessionId: 'c1', ...extra });
    const wrapper = { toolUseId: 'call_w', wrapper: true };
    // só watcher: o invólucro "exec" vale como ferramenta
    store.apply(cx('prompt', T0, { source: 'watcher' }));
    store.apply(cx('tool_start', T0 + 1, { source: 'watcher', tool: ['exec', 'bash'], meta: wrapper }));
    expect(store.get('codex:c1')).toMatchObject({ status: 'working', toolName: 'exec' });
    store.apply(cx('tool_end', T0 + 2, { source: 'watcher', tool: ['exec', 'bash'], meta: wrapper }));

    // hooks reportam a ferramenta real; o invólucro passa a ser ignorado
    store.apply(cx('tool_start', T0 + 10, { source: 'watcher', tool: ['exec', 'bash'], meta: { toolUseId: 'call_w2', wrapper: true } }));
    store.apply(cx('tool_start', T0 + 11, { source: 'hook', id: 'h1', tool: ['mcp__docs__read_page', 'read'] }));
    store.apply(cx('tool_end', T0 + 12, { source: 'hook', id: 'h1', tool: ['mcp__docs__read_page', 'read'] }));
    store.apply(cx('tool_start', T0 + 13, { source: 'hook', id: 'h2', tool: ['Bash', 'bash'] }));
    store.apply(cx('tool_start', T0 + 14, { source: 'watcher', tool: ['exec', 'bash'], meta: { toolUseId: 'call_w3', wrapper: true } }));
    store.apply(cx('error', T0 + 15, { source: 'watcher', tool: ['exec', 'bash'], meta: { wrapper: true } }));
    expect(store.get('codex:c1')).toMatchObject({ status: 'working', toolName: 'Bash' });
    store.apply(cx('tool_end', T0 + 16, { source: 'hook', id: 'h2', tool: ['Bash', 'bash'] }));
    // o invólucro aberto antes de os hooks aparecerem foi descartado: nada fica "preso"
    expect(store.get('codex:c1')).toMatchObject({ status: 'thinking', toolName: null });
    store.apply(cx('tool_end', T0 + 17, { source: 'watcher', tool: ['exec', 'bash'], meta: { toolUseId: 'call_w2', wrapper: true } }));
    store.apply(cx('stop', T0 + 20, { source: 'hook' }));
    expect(store.get('codex:c1')).toMatchObject({ status: 'done', counts: { prompts: 1, tools: 4, errors: 0 } });
  });

  it('dá nomes distintos às sessões presentes', () => {
    for (let i = 0; i < 60; i++) store.apply(ev('prompt', T0, { sessionId: `n${i}` }));
    const labels = store.list().map((s) => s.label);
    expect(new Set(labels).size).toBe(60);
  });

  it('não cria sessão a partir de um evento de fim nem emite "event" em replay', () => {
    const seen: string[] = [];
    store.on('event', (_k, e) => seen.push(e.event));
    expect(store.apply(ev('session_end', T0, { sessionId: 'fantasma' }))).toBe(false);
    expect(store.get('claude:fantasma')).toBeUndefined();
    store.apply(ev('prompt', T0), { replay: true });
    expect(seen).toEqual([]);
    expect(status()).toBe('thinking');
  });
});
