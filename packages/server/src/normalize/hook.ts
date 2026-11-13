import type { AgentKind, EventMeta, EventType, Ingest, NormalizedEvent } from '../schema.js';
import { isObj, num, projectFromCwd, str } from '../util.js';
import { categorizeTool } from './tools.js';

/** Corpo aceito em POST /events quando enviado pelo script de hook. */
export interface HookEnvelope {
  agent: AgentKind;
  /** Payload do hook já filtrado (somente metadados). */
  payload: Record<string, unknown>;
  pid?: number;
  ts?: number;
}

const WAITING_NOTIFICATIONS = new Set([
  'idle_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
]);

/**
 * Converte o payload de um hook (Claude Code ou Codex) em eventos normalizados.
 * Os dois agentes usam os mesmos nomes de evento (SessionStart, PreToolUse...).
 */
export function normalizeHook(env: HookEnvelope, now: number = Date.now()): Ingest[] {
  if (!isObj(env) || !isObj(env.payload)) return [];
  const agent: AgentKind = env.agent === 'codex' ? 'codex' : 'claude';
  const p = env.payload;
  const name = str(p.hook_event_name);
  const rootSession = str(p.session_id);
  if (!name || !rootSession) return [];

  const cwd = str(p.cwd) ?? '';
  const ts = num(env.ts) ?? now;
  const agentId = str(p.agent_id);
  const agentType = str(p.agent_type);
  const toolName = str(p.tool_name);

  // Eventos disparados de dentro de um subagente carregam o session_id do pai
  // e o agent_id do subagente: roteamos para a sessão-filha.
  const inSubagent = Boolean(agentId);
  const sessionId = inSubagent ? agentId! : rootSession;
  const parentSessionId = inSubagent ? rootSession : undefined;

  const meta: EventMeta = {};
  const pid = num(env.pid);
  // O pid é o do processo do agente principal; não vale para subagentes.
  if (pid && !inSubagent) meta.pid = pid;
  const model = str(p.model);
  if (model) meta.model = model;
  if (agentType) meta.agentType = agentType;

  const make = (event: EventType, extra: Partial<NormalizedEvent> = {}, extraMeta: EventMeta = {}): NormalizedEvent => {
    const merged = { ...meta, ...extraMeta };
    return {
      agent,
      sessionId,
      ...(parentSessionId ? { parentSessionId } : {}),
      cwd,
      project: projectFromCwd(cwd),
      event,
      toolCategory: 'other',
      ts,
      source: 'hook',
      ...extra,
      ...(Object.keys(merged).length ? { meta: merged } : {}),
    };
  };

  const tool = (): Partial<NormalizedEvent> => ({
    ...(toolName ? { toolName } : {}),
    toolCategory: categorizeTool(agent, toolName),
  });
  const toolMeta = (): EventMeta => {
    const id = str(p.tool_use_id);
    return id ? { toolUseId: id } : {};
  };

  switch (name) {
    case 'SessionStart': {
      const source = str(p.source);
      if (source === 'compact') return [];
      return [make('session_start', {}, source ? { reason: source } : {})];
    }
    case 'UserPromptSubmit':
      return [make('prompt')];
    case 'PreToolUse':
      return [make('tool_start', tool(), toolMeta())];
    case 'PostToolUse':
      return [make('tool_end', tool(), toolMeta())];
    case 'PostToolUseFailure':
      if (p.is_interrupt === true) return [make('stop', {}, { reason: 'interrupt' })];
      return [make('error', tool(), toolMeta())];
    case 'PermissionRequest':
      return [make('permission_wait', tool())];
    case 'Notification': {
      const type = str(p.notification_type);
      if (type === 'permission_prompt') return [make('permission_wait', {}, { reason: type })];
      if (type && WAITING_NOTIFICATIONS.has(type)) return [make('waiting_input', {}, { reason: type })];
      return [];
    }
    case 'SubagentStart':
      if (!inSubagent) return [];
      return [make('subagent_start')];
    case 'SubagentStop':
      if (!inSubagent) return [];
      return [make('subagent_stop')];
    case 'Stop':
      return [make('stop')];
    case 'Interrupt':
      return [make('stop', {}, { reason: 'interrupt' })];
    case 'StopFailure':
      return [make('error', {}, { reason: 'stop_failure' })];
    case 'SessionEnd': {
      const reason = str(p.reason);
      return [make('session_end', {}, reason ? { reason } : {})];
    }
    default:
      return [];
  }
}
