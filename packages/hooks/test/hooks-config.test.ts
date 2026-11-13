import { describe, expect, it } from 'vitest';
import {
  addHooks,
  countInstalled,
  deepEqual,
  detectIndent,
  HooksConfigError,
  removeHooks,
  serialize,
  type HookHandler,
  type JsonObject,
} from '../src/hooks-config.js';

const MARKER = 'agent-office-hook';
const ours = (extra: Partial<HookHandler> = {}): HookHandler => ({
  type: 'command',
  command: `'/home/u/.agent-office/bin/agent-office-hook' claude || true`,
  timeout: 5,
  ...extra,
});
const HANDLERS: Record<string, HookHandler> = {
  SessionStart: ours(),
  PreToolUse: ours({ async: true }),
  Stop: ours(),
};

/** Configuração parecida com a de um usuário real: hooks de terceiros, grupos vazios, outras chaves. */
const existing = (): JsonObject => ({
  model: 'opus',
  permissions: { allow: ['Bash(npm test)'] },
  hooks: {
    Notification: [{ matcher: '', hooks: [] }],
    Stop: [{ matcher: '', hooks: [] }],
    UserPromptSubmit: [{ matcher: '', hooks: [] }, { hooks: [{ type: 'command', command: 'codegraph prompt-hook' }] }],
    SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'node ~/.claude/manager.js' }] }],
  },
  theme: 'dark',
});

describe('addHooks', () => {
  it('mescla sem tocar nos hooks existentes', () => {
    const before = existing();
    const { config, record, changed } = addHooks(before, HANDLERS, MARKER);
    expect(changed).toBe(true);
    expect(before).toEqual(existing()); // não muta a entrada

    const hooks = config.hooks as Record<string, JsonObject[]>;
    // o que já existia continua igual e na mesma posição
    expect(hooks.Notification).toEqual([{ matcher: '', hooks: [] }]);
    expect(hooks.UserPromptSubmit).toEqual(existing().hooks && (existing().hooks as JsonObject).UserPromptSubmit);
    expect(hooks.SessionStart?.[0]).toEqual({ matcher: '', hooks: [{ type: 'command', command: 'node ~/.claude/manager.js' }] });
    expect(hooks.Stop?.[0]).toEqual({ matcher: '', hooks: [] });
    // o nosso grupo entra no final de cada evento
    expect(hooks.SessionStart?.[1]).toEqual({ hooks: [HANDLERS.SessionStart] });
    expect(hooks.Stop?.[1]).toEqual({ hooks: [HANDLERS.Stop] });
    expect(hooks.PreToolUse).toEqual([{ hooks: [HANDLERS.PreToolUse] }]);
    // demais chaves preservadas, na mesma ordem
    expect(Object.keys(config)).toEqual(['model', 'permissions', 'hooks', 'theme']);
    expect(record).toEqual({ createdEvents: ['PreToolUse'], createdHooksKey: false });
    expect(countInstalled(config, Object.keys(HANDLERS), MARKER)).toBe(3);
  });

  it('é idempotente', () => {
    const first = addHooks(existing(), HANDLERS, MARKER);
    const second = addHooks(first.config, HANDLERS, MARKER, first.record);
    expect(second.changed).toBe(false);
    expect(second.config).toEqual(first.config);
    expect(second.record).toEqual(first.record);
    const third = addHooks(second.config, HANDLERS, MARKER, second.record);
    expect(JSON.stringify(third.config)).toBe(JSON.stringify(first.config));
  });

  it('atualiza o comando sem duplicar quando o caminho muda', () => {
    const first = addHooks(existing(), HANDLERS, MARKER);
    const moved: Record<string, HookHandler> = Object.fromEntries(
      Object.entries(HANDLERS).map(([k, h]) => [k, { ...h, command: h.command.replace('/home/u', '/novo') }]),
    );
    const second = addHooks(first.config, moved, MARKER, first.record);
    expect(second.changed).toBe(true);
    const text = JSON.stringify(second.config);
    expect(text).not.toContain('/home/u/.agent-office');
    expect(text.match(/agent-office-hook' claude/g)).toHaveLength(3);
    expect(second.record).toEqual(first.record);
  });

  it('cria a chave "hooks" quando não existe', () => {
    const { config, record } = addHooks({ model: 'opus' }, HANDLERS, MARKER);
    expect(Object.keys(config.hooks as JsonObject)).toEqual(['SessionStart', 'PreToolUse', 'Stop']);
    expect(record).toEqual({ createdEvents: ['SessionStart', 'PreToolUse', 'Stop'], createdHooksKey: true });
  });

  it('recusa estruturas inesperadas em vez de sobrescrever', () => {
    expect(() => addHooks({ hooks: 'x' }, HANDLERS, MARKER)).toThrow(HooksConfigError);
    expect(() => addHooks({ hooks: { Stop: {} } }, HANDLERS, MARKER)).toThrow(HooksConfigError);
    expect(() => addHooks({}, { Stop: { type: 'command', command: 'outro' } }, MARKER)).toThrow(HooksConfigError);
  });
});

describe('removeHooks', () => {
  it('restaura exatamente a configuração original', () => {
    const original = existing();
    const { config, record } = addHooks(original, HANDLERS, MARKER);
    const { config: restored, removed } = removeHooks(config, MARKER, record);
    expect(removed).toBe(3);
    expect(restored).toEqual(original);
    expect(JSON.stringify(restored)).toBe(JSON.stringify(original));
  });

  it('remove a chave "hooks" somente se fomos nós que criamos', () => {
    const created = addHooks({ model: 'opus' }, HANDLERS, MARKER);
    expect(removeHooks(created.config, MARKER, created.record).config).toEqual({ model: 'opus' });

    const emptyBefore = addHooks({ hooks: {} }, HANDLERS, MARKER);
    expect(removeHooks(emptyBefore.config, MARKER, emptyBefore.record).config).toEqual({ hooks: {} });

    const emptyEvent = addHooks({ hooks: { Stop: [] } }, HANDLERS, MARKER);
    expect(removeHooks(emptyEvent.config, MARKER, emptyEvent.record).config).toEqual({ hooks: { Stop: [] } });
  });

  it('preserva hooks de terceiros adicionados depois e no mesmo grupo', () => {
    const { config, record } = addHooks(existing(), HANDLERS, MARKER);
    const hooks = config.hooks as Record<string, JsonObject[]>;
    // o usuário adiciona um hook dele dentro do NOSSO grupo e um evento novo
    (hooks.PreToolUse![0]!.hooks as JsonObject[]).push({ type: 'command', command: 'meu-linter' });
    hooks.PreCompact = [{ hooks: [{ type: 'command', command: 'echo compact' }] }];
    const { config: after, removed } = removeHooks(config, MARKER, record);
    expect(removed).toBe(3);
    const left = after.hooks as Record<string, JsonObject[]>;
    expect(left.PreToolUse).toEqual([{ hooks: [{ type: 'command', command: 'meu-linter' }] }]);
    expect(left.PreCompact).toEqual([{ hooks: [{ type: 'command', command: 'echo compact' }] }]);
    expect(JSON.stringify(after)).not.toContain(MARKER);
  });

  it('sem registro de instalação, limpa o que ficou vazio por nossa causa', () => {
    const { config } = addHooks({ model: 'opus' }, HANDLERS, MARKER);
    expect(removeHooks(config, MARKER).config).toEqual({ model: 'opus' });
  });

  it('não faz nada quando não há hooks nossos', () => {
    const { config, removed } = removeHooks(existing(), MARKER);
    expect(removed).toBe(0);
    expect(config).toEqual(existing());
  });
});

describe('utilidades', () => {
  it('deepEqual compara estruturas JSON', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined as never })).toBe(false);
  });

  it('preserva indentação e quebra de linha final', () => {
    expect(detectIndent('{\n    "a": 1\n}')).toBe('    ');
    expect(detectIndent('{\n\t"a": 1\n}')).toBe('\t');
    expect(serialize({ a: 1 }, '{\n    "a": 1\n}')).toBe('{\n    "a": 1\n}');
    expect(serialize({ a: 1 }, '{\n  "a": 1\n}\n')).toBe('{\n  "a": 1\n}\n');
    expect(serialize({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });
});
