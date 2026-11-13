import { describe, expect, it } from 'vitest';
import { ClaudeTranscriptParser, classifyClaudePath } from '../src/normalize/claude.js';
import { CodexRolloutParser, codexSessionIdFromPath } from '../src/normalize/codex.js';
import { normalizeHook } from '../src/normalize/hook.js';
import { categorizeTool } from '../src/normalize/tools.js';
import type { Ingest, NormalizedEvent } from '../src/schema.js';
import { projectFromCwd } from '../src/util.js';

const events = (items: Ingest[]): NormalizedEvent[] => items.filter((i): i is NormalizedEvent => !('kind' in i));

describe('categorizeTool', () => {
  it('classifica as ferramentas do Claude Code', () => {
    expect(categorizeTool('claude', 'Read')).toBe('read');
    expect(categorizeTool('claude', 'Write')).toBe('write');
    expect(categorizeTool('claude', 'Edit')).toBe('edit');
    expect(categorizeTool('claude', 'MultiEdit')).toBe('edit');
    expect(categorizeTool('claude', 'Bash')).toBe('bash');
    expect(categorizeTool('claude', 'Grep')).toBe('search');
    expect(categorizeTool('claude', 'Glob')).toBe('search');
    expect(categorizeTool('claude', 'WebFetch')).toBe('web');
    expect(categorizeTool('claude', 'WebSearch')).toBe('web');
    expect(categorizeTool('claude', 'TodoWrite')).toBe('plan');
    expect(categorizeTool('claude', 'Agent')).toBe('plan');
    expect(categorizeTool('claude', 'Skill')).toBe('other');
  });

  it('classifica as ferramentas do Codex', () => {
    expect(categorizeTool('codex', 'Bash')).toBe('bash');
    expect(categorizeTool('codex', 'exec')).toBe('bash');
    expect(categorizeTool('codex', 'local_shell')).toBe('bash');
    expect(categorizeTool('codex', 'apply_patch')).toBe('edit');
    expect(categorizeTool('codex', 'update_plan')).toBe('plan');
    expect(categorizeTool('codex', 'spawn_agent')).toBe('plan');
    expect(categorizeTool('codex', 'web_search')).toBe('web');
  });

  it('usa heurística para MCP e nomes desconhecidos', () => {
    expect(categorizeTool('claude', 'mcp__Claude_Browser__read_page')).toBe('web');
    expect(categorizeTool('claude', 'mcp__github__search_issues')).toBe('search');
    expect(categorizeTool('claude', 'mcp__fs__read_file')).toBe('read');
    expect(categorizeTool('claude', 'mcp__slack__send_message')).toBe('other');
    expect(categorizeTool('codex', undefined)).toBe('other');
  });
});

describe('projectFromCwd', () => {
  it('usa o último segmento do caminho', () => {
    expect(projectFromCwd('/Users/ana/github/loja')).toBe('loja');
    expect(projectFromCwd('/Users/ana/github/loja/')).toBe('loja');
    expect(projectFromCwd('C:\\dev\\loja')).toBe('loja');
    expect(projectFromCwd('')).toBe('desconhecido');
  });

  it('atribui worktrees ao repositório de origem', () => {
    expect(projectFromCwd('/Users/ana/github/loja/.claude/worktrees/feat-x-1a2b')).toBe('loja');
    expect(projectFromCwd('/Users/ana/.codex/worktrees/84dd/loja')).toBe('loja');
  });
});

describe('normalizeHook (Claude Code)', () => {
  const base = { session_id: 's1', cwd: '/Users/ana/github/loja' };
  const hook = (payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    events(normalizeHook({ agent: 'claude', payload: { ...base, ...payload }, ts: 1000, ...extra }));

  it('mapeia o ciclo de vida da sessão', () => {
    expect(hook({ hook_event_name: 'SessionStart', source: 'startup' }, { pid: 42 })[0]).toMatchObject({
      agent: 'claude',
      sessionId: 's1',
      cwd: '/Users/ana/github/loja',
      project: 'loja',
      event: 'session_start',
      toolCategory: 'other',
      ts: 1000,
      source: 'hook',
      meta: { pid: 42, reason: 'startup' },
    });
    expect(hook({ hook_event_name: 'UserPromptSubmit' })[0]?.event).toBe('prompt');
    expect(hook({ hook_event_name: 'Stop' })[0]?.event).toBe('stop');
    expect(hook({ hook_event_name: 'SessionEnd', reason: 'other' })[0]).toMatchObject({
      event: 'session_end',
      meta: { reason: 'other' },
    });
  });

  it('usa o título da sessão como assunto (só na sessão principal)', () => {
    expect(hook({ hook_event_name: 'UserPromptSubmit', session_title: 'Corrigir frete no checkout' })[0]?.meta).toMatchObject({
      title: 'Corrigir frete no checkout',
    });
    const sub = hook({ hook_event_name: 'PreToolUse', tool_name: 'Grep', agent_id: 'a1', session_title: 'Corrigir frete' })[0];
    expect(sub?.meta?.title).toBeUndefined();
  });

  it('ignora SessionStart de compactação', () => {
    expect(hook({ hook_event_name: 'SessionStart', source: 'compact' })).toEqual([]);
  });

  it('mapeia ferramentas com categoria e id', () => {
    expect(hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'toolu_1' })[0]).toMatchObject({
      event: 'tool_start',
      toolName: 'Edit',
      toolCategory: 'edit',
      meta: { toolUseId: 'toolu_1' },
    });
    expect(hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_2' })[0]).toMatchObject({
      event: 'tool_end',
      toolCategory: 'bash',
    });
    expect(hook({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'toolu_3' })[0]).toMatchObject({
      event: 'error',
      toolCategory: 'bash',
      meta: { toolUseId: 'toolu_3' },
    });
    expect(hook({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', is_interrupt: true })[0]).toMatchObject({
      event: 'stop',
      meta: { reason: 'interrupt' },
    });
  });

  it('mapeia pedidos de permissão e espera por input', () => {
    expect(hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' })[0]).toMatchObject({
      event: 'permission_wait',
      toolCategory: 'bash',
    });
    expect(hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' })[0]?.event).toBe(
      'permission_wait',
    );
    expect(hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' })[0]?.event).toBe('waiting_input');
    expect(hook({ hook_event_name: 'Notification', notification_type: 'auth_success' })).toEqual([]);
  });

  it('roteia eventos de subagente para a sessão-filha', () => {
    const start = hook({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' }, { pid: 42 })[0];
    expect(start).toMatchObject({
      event: 'subagent_start',
      sessionId: 'a1',
      parentSessionId: 's1',
      meta: { agentType: 'Explore' },
    });
    expect(start?.meta?.pid).toBeUndefined();
    const tool = hook({ hook_event_name: 'PreToolUse', tool_name: 'Grep', agent_id: 'a1', agent_type: 'Explore' })[0];
    expect(tool).toMatchObject({ event: 'tool_start', sessionId: 'a1', parentSessionId: 's1', toolCategory: 'search' });
    expect(hook({ hook_event_name: 'SubagentStop', agent_id: 'a1' })[0]?.event).toBe('subagent_stop');
  });

  it('descarta payloads inválidos ou eventos desconhecidos', () => {
    expect(normalizeHook({ agent: 'claude', payload: { hook_event_name: 'Stop' } })).toEqual([]);
    expect(normalizeHook({ agent: 'claude', payload: { session_id: 's1' } })).toEqual([]);
    expect(hook({ hook_event_name: 'PreCompact' })).toEqual([]);
    expect(normalizeHook(null as never)).toEqual([]);
  });

  it('nunca propaga conteúdo, mesmo que venha no payload', () => {
    const out = normalizeHook({
      agent: 'claude',
      payload: {
        ...base,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'cat segredo.txt' },
        prompt: 'minha senha é 1234',
      },
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain('segredo');
    expect(text).not.toContain('senha');
  });
});

describe('normalizeHook (Codex)', () => {
  const hook = (payload: Record<string, unknown>) =>
    events(normalizeHook({ agent: 'codex', payload: { session_id: 'c1', cwd: '/repo/api', ...payload }, ts: 5 }));

  it('usa os mesmos nomes de evento com as ferramentas do Codex', () => {
    expect(hook({ hook_event_name: 'SessionStart', source: 'startup', model: 'gpt-5.5' })[0]).toMatchObject({
      agent: 'codex',
      event: 'session_start',
      project: 'api',
      meta: { model: 'gpt-5.5' },
    });
    expect(hook({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_use_id: 'call_1' })[0]).toMatchObject({
      event: 'tool_start',
      toolCategory: 'edit',
    });
    expect(hook({ hook_event_name: 'Interrupt' })[0]).toMatchObject({ event: 'stop', meta: { reason: 'interrupt' } });
  });
});

describe('ClaudeTranscriptParser', () => {
  it('classifica caminhos de transcripts', () => {
    expect(classifyClaudePath('-Users-ana-loja/abc.jsonl')).toEqual({ sessionId: 'abc' });
    expect(classifyClaudePath('-Users-ana-loja/abc/subagents/agent-x1.jsonl')).toEqual({ sessionId: 'abc', agentId: 'x1' });
    expect(classifyClaudePath('-Users-ana-loja/abc/tool-results/out.txt')).toBeNull();
    expect(classifyClaudePath('-Users-ana-loja/memory/notes.md')).toBeNull();
  });

  const line = (o: Record<string, unknown>) => ({
    sessionId: 'abc',
    cwd: '/Users/ana/loja',
    timestamp: '2026-11-13T12:00:00.000Z',
    ...o,
  });

  it('extrai prompt, ferramentas, contexto e fim de turno', () => {
    const p = new ClaudeTranscriptParser({ sessionId: 'abc' }, { fresh: true });
    const prompt = events(p.parse(line({ type: 'user', entrypoint: 'cli', message: { role: 'user', content: 'faça X com a senha 123' } })));
    expect(prompt.map((e) => e.event)).toEqual(['session_start', 'prompt']);
    expect(JSON.stringify(prompt)).not.toContain('senha');
    expect(prompt[0]).toMatchObject({ sessionId: 'abc', project: 'loja', source: 'watcher', meta: { entrypoint: 'cli' } });

    const assistant = p.parse(
      line({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-opus-4',
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 90 },
          content: [
            { type: 'text', text: 'vou ler' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/segredo' } },
          ],
        },
      }),
    );
    expect(assistant[0]).toMatchObject({ kind: 'meta', meta: { contextTokens: 5100, model: 'claude-opus-4' } });
    expect(events(assistant)[0]).toMatchObject({
      event: 'tool_start',
      toolName: 'Read',
      toolCategory: 'read',
      meta: { toolUseId: 'toolu_1' },
    });
    expect(JSON.stringify(assistant)).not.toContain('segredo');

    const result = events(
      p.parse(line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' }] } })),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ event: 'tool_end', toolName: 'Read', toolCategory: 'read' });

    const end = events(
      p.parse(line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'pronto' }] } })),
    );
    expect(end.map((e) => e.event)).toEqual(['stop']);
  });

  it('lê o título da sessão das linhas custom-title', () => {
    const p = new ClaudeTranscriptParser({ sessionId: 'abc' });
    expect(p.parse({ type: 'custom-title', customTitle: 'Agent Office 2D dashboard', sessionId: 'abc' })).toMatchObject([
      { kind: 'meta', agent: 'claude', sessionId: 'abc', meta: { title: 'Agent Office 2D dashboard' } },
    ]);
    const sub = new ClaudeTranscriptParser({ sessionId: 'abc', agentId: 'x1' });
    expect(sub.parse({ type: 'custom-title', customTitle: 'do pai' })).toEqual([]);
  });

  it('trata erro de ferramenta, interrupção e linhas irrelevantes', () => {
    const p = new ClaudeTranscriptParser({ sessionId: 'abc' });
    const err = events(
      p.parse(line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't9', is_error: true }] } })),
    );
    expect(err[0]).toMatchObject({ event: 'error', meta: { toolUseId: 't9' } });
    const interrupt = events(
      p.parse(line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } })),
    );
    expect(interrupt[0]).toMatchObject({ event: 'stop', meta: { reason: 'interrupt' } });
    expect(p.parse(line({ type: 'file-history-snapshot' }))).toEqual([]);
    expect(p.parse(line({ type: 'user', isMeta: true, message: { role: 'user', content: 'x' } }))).toEqual([]);
    expect(p.parse('lixo')).toEqual([]);
  });

  it('emite eventos de subagente para transcripts em subagents/', () => {
    const p = new ClaudeTranscriptParser({ sessionId: 'abc', agentId: 'x1' }, { fresh: true });
    const first = events(p.parse(line({ type: 'user', isSidechain: true, message: { role: 'user', content: 'tarefa' } })));
    expect(first.map((e) => e.event)).toEqual(['subagent_start']);
    expect(first[0]).toMatchObject({ sessionId: 'x1', parentSessionId: 'abc' });
    const end = events(
      p.parse(line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'fim' }] } })),
    );
    expect(end.map((e) => e.event)).toEqual(['subagent_stop']);
  });
});

describe('CodexRolloutParser', () => {
  const ID = '01a1d277-ce8c-70f0-8553-f45aa93772ef';
  const rec = (type: string, payload: Record<string, unknown>) => ({ timestamp: '2026-11-13T12:00:00.000Z', type, payload });

  it('extrai o id da thread do nome do arquivo', () => {
    expect(codexSessionIdFromPath(`/x/sessions/2026/11/12/rollout-2026-11-12T22-13-49-${ID}.jsonl`)).toBe(ID);
    expect(codexSessionIdFromPath('/x/sessions/2026/11/12/outra-coisa.jsonl')).toBeNull();
    expect(codexSessionIdFromPath(`/x/archived/rollout-2026-11-12T22-13-49-${ID}.jsonl.zst`)).toBeNull();
  });

  it('extrai início, turnos, ferramentas e contexto', () => {
    const p = new CodexRolloutParser(ID);
    const meta = events(
      p.parse(rec('session_meta', { id: ID, cwd: '/repo/api', originator: 'Codex Desktop', timestamp: '2026-11-13T11:00:00.000Z', base_instructions: { text: 'segredo' } })),
    );
    expect(meta[0]).toMatchObject({
      agent: 'codex',
      sessionId: ID,
      event: 'session_start',
      project: 'api',
      ts: Date.parse('2026-11-13T11:00:00.000Z'),
      meta: { entrypoint: 'Codex Desktop' },
    });
    expect(JSON.stringify(meta)).not.toContain('segredo');

    expect(events(p.parse(rec('event_msg', { type: 'task_started', model_context_window: 400000 })))[0]).toMatchObject({
      event: 'prompt',
      meta: { contextWindow: 400000 },
    });
    const start = events(p.parse(rec('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'call_1', input: 'rm -rf segredo' })));
    expect(start[0]).toMatchObject({ event: 'tool_start', toolName: 'exec', toolCategory: 'bash', meta: { toolUseId: 'call_1' } });
    expect(JSON.stringify(start)).not.toContain('segredo');
    expect(events(p.parse(rec('response_item', { type: 'custom_tool_call_output', call_id: 'call_1', output: 'x' })))[0]).toMatchObject({
      event: 'tool_end',
      toolName: 'exec',
      toolCategory: 'bash',
    });
    expect(
      p.parse(rec('event_msg', { type: 'token_count', info: { last_token_usage: { total_tokens: 1234 }, model_context_window: 400000 } }))[0],
    ).toMatchObject({ kind: 'meta', meta: { contextTokens: 1234, contextWindow: 400000 } });
    expect(events(p.parse(rec('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', status: 'failed' } })))[0]?.event).toBe('error');
    expect(events(p.parse(rec('event_msg', { type: 'task_complete', last_agent_message: 'segredo' })))[0]?.event).toBe('stop');
    expect(events(p.parse(rec('event_msg', { type: 'turn_aborted', reason: 'interrupted' })))[0]).toMatchObject({
      event: 'stop',
      meta: { reason: 'interrupted' },
    });
    expect(p.parse(rec('response_item', { type: 'reasoning' }))).toEqual([]);
    expect(p.parse(rec('world_state', {}))).toEqual([]);
  });

  it('marca o invólucro do code mode e encerra sessões de `codex exec` ao fim do turno', () => {
    const p = new CodexRolloutParser(ID);
    p.parse(rec('session_meta', { id: ID, cwd: '/repo/api', originator: 'codex_exec', source: 'exec' }));
    const start = events(p.parse(rec('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'c1' })));
    expect(start[0]?.meta).toEqual({ toolUseId: 'c1', wrapper: true });
    expect(events(p.parse(rec('response_item', { type: 'custom_tool_call_output', call_id: 'c1' })))[0]?.meta).toEqual({
      toolUseId: 'c1',
      wrapper: true,
    });
    const plain = events(p.parse(rec('response_item', { type: 'function_call', name: 'apply_patch', call_id: 'c2' })));
    expect(plain[0]?.meta).toEqual({ toolUseId: 'c2' });
    expect(events(p.parse(rec('event_msg', { type: 'task_complete' }))).map((e) => e.event)).toEqual(['stop', 'session_end']);

    const desktop = new CodexRolloutParser(ID);
    desktop.parse(rec('session_meta', { id: ID, cwd: '/repo/api', originator: 'Codex Desktop', source: 'vscode' }));
    expect(events(desktop.parse(rec('event_msg', { type: 'task_complete' }))).map((e) => e.event)).toEqual(['stop']);
  });

  it('liga subagentes à thread-pai', () => {
    const p = new CodexRolloutParser(ID);
    const meta = events(
      p.parse(
        rec('session_meta', {
          id: ID,
          cwd: '/repo/api',
          agent_nickname: 'Laplace',
          agent_path: '/root/implement_app_p0p1',
          source: { subagent: { thread_spawn: { parent_thread_id: 'parent-1', depth: 1 } } },
        }),
      ),
    );
    expect(meta[0]).toMatchObject({
      event: 'subagent_start',
      parentSessionId: 'parent-1',
      meta: { nickname: 'Laplace', title: 'implement app p0p1' },
    });
    expect(events(p.parse(rec('event_msg', { type: 'task_started' })))[0]).toMatchObject({ parentSessionId: 'parent-1' });
  });
});
