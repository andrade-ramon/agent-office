import type { EventMeta, EventType, Ingest, NormalizedEvent, ToolCategory } from '../schema.js';
import { isObj, num, parseTs, projectFromCwd, str } from '../util.js';
import { categorizeTool } from './tools.js';

/** Identidade de um transcript do Claude Code, derivada do caminho do arquivo. */
export interface ClaudeFileInfo {
  /** Sessão dona do arquivo (para subagentes, a sessão-pai). */
  sessionId: string;
  /** Presente quando o arquivo é o transcript de um subagente. */
  agentId?: string;
}

/**
 * `<projects>/<projeto>/<sessionId>.jsonl`                       → sessão
 * `<projects>/<projeto>/<sessionId>/subagents/agent-<id>.jsonl`  → subagente
 */
export function classifyClaudePath(relativePath: string): ClaudeFileInfo | null {
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  if (parts.length === 2 && parts[1]!.endsWith('.jsonl')) {
    return { sessionId: parts[1]!.slice(0, -'.jsonl'.length) };
  }
  if (parts.length === 4 && parts[2] === 'subagents') {
    const m = parts[3]!.match(/^agent-(.+)\.jsonl$/);
    if (m) return { sessionId: parts[1]!, agentId: m[1]! };
  }
  return null;
}

interface ParserOptions {
  /** Arquivo recém-criado: emite session_start/subagent_start na primeira linha. */
  fresh?: boolean;
}

/**
 * Parser incremental de transcripts (`~/.claude/projects/**.jsonl`).
 * Lê o conteúdo apenas para classificar a linha; nada além de metadados sai daqui.
 */
export class ClaudeTranscriptParser {
  private readonly tools = new Map<string, { name: string; category: ToolCategory }>();
  private started = false;
  private cwd = '';

  constructor(
    private readonly info: ClaudeFileInfo,
    private readonly opts: ParserOptions = {},
  ) {}

  parse(line: unknown): Ingest[] {
    if (!isObj(line)) return [];
    const type = str(line.type);
    if (type === 'custom-title' || type === 'ai-title') {
      // Título que o Claude Code dá à sessão (o mesmo da barra lateral do app).
      const title = str(line.customTitle) ?? str(line.aiTitle) ?? str(line.title);
      if (!title || this.info.agentId) return [];
      return [{ kind: 'meta', agent: 'claude', sessionId: this.info.sessionId, ts: parseTs(line.timestamp, Date.now()), meta: { title } }];
    }
    if (type !== 'user' && type !== 'assistant') return [];
    const message = isObj(line.message) ? line.message : undefined;
    if (!message) return [];

    const lineCwd = str(line.cwd);
    if (lineCwd) this.cwd = lineCwd;
    const ts = parseTs(line.timestamp, Date.now());
    const sub = Boolean(this.info.agentId);
    const sessionId = this.info.agentId ?? this.info.sessionId;
    const out: Ingest[] = [];

    const make = (event: EventType, extra: Partial<NormalizedEvent> = {}, meta?: EventMeta): NormalizedEvent => ({
      agent: 'claude',
      sessionId,
      ...(sub ? { parentSessionId: this.info.sessionId } : {}),
      cwd: this.cwd,
      project: projectFromCwd(this.cwd),
      event,
      toolCategory: 'other',
      ts,
      source: 'watcher',
      ...extra,
      ...(meta && Object.keys(meta).length ? { meta } : {}),
    });

    if (!this.started) {
      this.started = true;
      if (this.opts.fresh) {
        const entry = str(line.entrypoint);
        out.push(make(sub ? 'subagent_start' : 'session_start', {}, entry ? { entrypoint: entry } : undefined));
      }
    }

    const content = message.content;

    if (type === 'assistant') {
      const model = str(message.model);
      const usage = isObj(message.usage) ? message.usage : undefined;
      if (usage) {
        const tokens =
          (num(usage.input_tokens) ?? 0) +
          (num(usage.cache_read_input_tokens) ?? 0) +
          (num(usage.cache_creation_input_tokens) ?? 0);
        if (tokens > 0) {
          out.push({
            kind: 'meta',
            agent: 'claude',
            sessionId,
            ts,
            meta: { contextTokens: tokens, ...(model && model !== '<synthetic>' ? { model } : {}) },
          });
        }
      }
      if (line.isApiErrorMessage === true) {
        out.push(make('error', {}, { reason: 'api_error' }));
        return out;
      }
      let sawTool = false;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isObj(block) || block.type !== 'tool_use') continue;
          sawTool = true;
          const name = str(block.name) ?? 'tool';
          const id = str(block.id);
          const category = categorizeTool('claude', name);
          if (id) this.tools.set(id, { name, category });
          out.push(make('tool_start', { toolName: name, toolCategory: category }, id ? { toolUseId: id } : undefined));
        }
      }
      if (!sawTool && message.stop_reason === 'end_turn') {
        out.push(make(sub ? 'subagent_stop' : 'stop'));
      }
      return out;
    }

    // type === 'user'
    if (line.isMeta === true || line.isCompactSummary === true) return out;

    if (typeof content === 'string') {
      if (!sub) out.push(make(isInterrupt(content) ? 'stop' : 'prompt', {}, isInterrupt(content) ? { reason: 'interrupt' } : undefined));
      return out;
    }
    if (!Array.isArray(content)) return out;

    let sawResult = false;
    let sawText = false;
    let interrupted = false;
    for (const block of content) {
      if (!isObj(block)) continue;
      if (block.type === 'tool_result') {
        sawResult = true;
        const id = str(block.tool_use_id);
        const known = id ? this.tools.get(id) : undefined;
        if (id) this.tools.delete(id);
        const extra: Partial<NormalizedEvent> = known
          ? { toolName: known.name, toolCategory: known.category }
          : {};
        out.push(make(block.is_error === true ? 'error' : 'tool_end', extra, id ? { toolUseId: id } : undefined));
      } else if (block.type === 'text') {
        sawText = true;
        if (isInterrupt(str(block.text) ?? '')) interrupted = true;
      }
    }
    if (interrupted) {
      out.push(make('stop', {}, { reason: 'interrupt' }));
    } else if (sawText && !sawResult && !sub) {
      out.push(make('prompt'));
    }
    return out;
  }
}

function isInterrupt(text: string): boolean {
  return text.startsWith('[Request interrupted');
}
