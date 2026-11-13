import type { EventMeta, EventType, Ingest, NormalizedEvent, ToolCategory } from '../schema.js';
import { humanizeSlug, isObj, num, parseTs, projectFromCwd, str } from '../util.js';
import { categorizeTool } from './tools.js';

const ROLLOUT_RE = /rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[^/\\]*\.jsonl$/i;

/** Extrai o id da thread do nome `rollout-<data>-<uuid>.jsonl`. */
export function codexSessionIdFromPath(path: string): string | null {
  const m = path.match(ROLLOUT_RE);
  return m ? m[1]!.toLowerCase() : null;
}

const CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'tool_search_call']);
const OUTPUT_TYPES = new Set([
  'function_call_output',
  'custom_tool_call_output',
  'local_shell_call_output',
  'tool_search_output',
]);

/**
 * Parser incremental dos rollouts do Codex (`~/.codex/sessions/**.jsonl`).
 * O formato não é uma interface estável: tipos desconhecidos são ignorados.
 */
export class CodexRolloutParser {
  private readonly tools = new Map<string, { name: string; category: ToolCategory; wrapper?: boolean }>();
  private cwd = '';
  private parentSessionId: string | undefined;
  private sawMeta = false;
  /** `codex exec`: o processo termina junto com o turno. */
  private oneShot = false;

  constructor(private readonly sessionId: string) {}

  parse(line: unknown): Ingest[] {
    if (!isObj(line)) return [];
    const type = str(line.type);
    const payload = isObj(line.payload) ? line.payload : undefined;
    if (!type || !payload) return [];
    const ts = parseTs(line.timestamp, Date.now());

    const make = (event: EventType, extra: Partial<NormalizedEvent> = {}, meta?: EventMeta): NormalizedEvent => ({
      agent: 'codex',
      sessionId: this.sessionId,
      ...(this.parentSessionId ? { parentSessionId: this.parentSessionId } : {}),
      cwd: this.cwd,
      project: projectFromCwd(this.cwd),
      event,
      toolCategory: 'other',
      ts,
      source: 'watcher',
      ...extra,
      ...(meta && Object.keys(meta).length ? { meta } : {}),
    });

    switch (type) {
      case 'session_meta': {
        if (this.sawMeta) return [];
        this.sawMeta = true;
        const cwd = str(payload.cwd);
        if (cwd) this.cwd = cwd;
        const source = isObj(payload.source) ? payload.source : undefined;
        const subagent = source && isObj(source.subagent) ? source.subagent : undefined;
        const spawn = subagent && isObj(subagent.thread_spawn) ? subagent.thread_spawn : undefined;
        const parent = str(payload.parent_thread_id) ?? (spawn ? str(spawn.parent_thread_id) : undefined);
        if (parent && parent !== this.sessionId) this.parentSessionId = parent;
        const meta: EventMeta = {};
        const originator = str(payload.originator);
        if (originator) meta.entrypoint = originator;
        this.oneShot = originator === 'codex_exec' || str(payload.source) === 'exec';
        const nickname = str(payload.agent_nickname) ?? (spawn ? str(spawn.agent_nickname) : undefined);
        if (nickname) meta.nickname = nickname;
        const role = str(payload.agent_role) ?? (spawn ? str(spawn.agent_role) : undefined);
        if (role) meta.agentType = role;
        // Subagentes do Codex trazem a tarefa no caminho do agente (/root/implement_app → "implement app").
        const task = this.parentSessionId
          ? humanizeSlug(str(payload.agent_path) ?? (spawn ? str(spawn.agent_path) : undefined))
          : undefined;
        if (task) meta.title = task;
        const started = parseTs(payload.timestamp, ts);
        return [{ ...make(this.parentSessionId ? 'subagent_start' : 'session_start', {}, meta), ts: started }];
      }

      case 'turn_context': {
        const cwd = str(payload.cwd);
        if (cwd) this.cwd = cwd;
        const model = str(payload.model);
        if (!model) return [];
        return [{ kind: 'meta', agent: 'codex', sessionId: this.sessionId, ts, ...(cwd ? { cwd } : {}), meta: { model } }];
      }

      case 'event_msg': {
        const kind = str(payload.type);
        switch (kind) {
          case 'task_started': {
            const window = num(payload.model_context_window);
            return [make('prompt', {}, window ? { contextWindow: window } : undefined)];
          }
          case 'task_complete':
            return this.oneShot && !this.parentSessionId
              ? [make('stop'), { ...make('session_end', {}, { reason: 'exec_finished' }), ts: ts + 1 }]
              : [make('stop')];
          case 'turn_aborted': {
            const stop = make('stop', {}, { reason: str(payload.reason) ?? 'aborted' });
            return this.oneShot && !this.parentSessionId
              ? [stop, { ...make('session_end', {}, { reason: 'exec_aborted' }), ts: ts + 1 }]
              : [stop];
          }
          case 'token_count': {
            const info = isObj(payload.info) ? payload.info : undefined;
            const last = info && isObj(info.last_token_usage) ? info.last_token_usage : undefined;
            const tokens = last ? (num(last.total_tokens) ?? num(last.input_tokens)) : undefined;
            const window = info ? num(info.model_context_window) : undefined;
            if (!tokens && !window) return [];
            return [
              {
                kind: 'meta',
                agent: 'codex',
                sessionId: this.sessionId,
                ts,
                meta: { ...(tokens ? { contextTokens: tokens } : {}), ...(window ? { contextWindow: window } : {}) },
              },
            ];
          }
          case 'item_completed': {
            const item = isObj(payload.item) ? payload.item : undefined;
            if (item && item.type === 'CommandExecution' && item.status === 'failed') {
              return [make('error', { toolCategory: 'bash', toolName: 'exec' }, { wrapper: true })];
            }
            return [];
          }
          case 'error':
          case 'stream_error':
            return [make('error', {}, { reason: kind })];
          default:
            if (kind && /approval_request$/.test(kind)) return [make('permission_wait', {}, { reason: kind })];
            if (kind && /request_user_input|elicitation_request/.test(kind)) {
              return [make('waiting_input', {}, { reason: kind })];
            }
            return [];
        }
      }

      case 'response_item': {
        const kind = str(payload.type);
        if (!kind) return [];
        if (kind === 'web_search_call') {
          // Ferramenta hospedada: não há registro de saída; abre e fecha de uma vez.
          const id = str(payload.call_id) ?? str(payload.id);
          const meta = id ? { toolUseId: id } : undefined;
          const extra = { toolName: 'web_search', toolCategory: 'web' as ToolCategory };
          return [make('tool_start', extra, meta), { ...make('tool_end', extra, meta), ts: ts + 1 }];
        }
        if (CALL_TYPES.has(kind)) {
          const name = str(payload.name) ?? (kind === 'local_shell_call' ? 'local_shell' : kind.replace(/_call$/, ''));
          const id = str(payload.call_id) ?? str(payload.id);
          const category = categorizeTool('codex', name);
          const wrapper = kind === 'custom_tool_call' && name === 'exec';
          if (id) this.tools.set(id, { name, category, wrapper });
          return [
            make('tool_start', { toolName: name, toolCategory: category }, {
              ...(id ? { toolUseId: id } : {}),
              ...(wrapper ? { wrapper: true } : {}),
            }),
          ];
        }
        if (OUTPUT_TYPES.has(kind)) {
          const id = str(payload.call_id) ?? str(payload.id);
          const known = id ? this.tools.get(id) : undefined;
          if (id) this.tools.delete(id);
          const extra: Partial<NormalizedEvent> = known ? { toolName: known.name, toolCategory: known.category } : {};
          return [
            make('tool_end', extra, {
              ...(id ? { toolUseId: id } : {}),
              ...(known?.wrapper ? { wrapper: true } : {}),
            }),
          ];
        }
        return [];
      }

      default:
        return [];
    }
  }
}
