import type { AgentKind, EventMeta, EventType, NormalizedEvent, ToolCategory } from './schema.js';
import type { SessionStore } from './state.js';

const PROJECTS = ['loja-virtual', 'api-pagamentos', 'app-mobile', 'infra-cloud', 'site-docs', 'painel-admin', 'bot-suporte'];

const TOOLS: Record<AgentKind, Record<ToolCategory, string[]>> = {
  claude: {
    read: ['Read'],
    write: ['Write'],
    edit: ['Edit'],
    bash: ['Bash'],
    search: ['Grep', 'Glob'],
    web: ['WebFetch', 'WebSearch'],
    plan: ['TodoWrite'],
    other: ['Skill'],
  },
  codex: {
    read: ['read_file'],
    write: ['apply_patch'],
    edit: ['apply_patch'],
    bash: ['Bash'],
    search: ['grep_files'],
    web: ['web_search'],
    plan: ['update_plan'],
    other: ['mcp__docs__lookup'],
  },
};

const WEIGHTS: [ToolCategory, number][] = [
  ['read', 22],
  ['edit', 20],
  ['bash', 18],
  ['search', 14],
  ['write', 8],
  ['plan', 7],
  ['web', 7],
  ['other', 4],
];

const SUBAGENT_TYPES = ['Explore', 'general-purpose', 'code-reviewer', 'Plan'];

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]!;
}
function pickCategory(): ToolCategory {
  const total = WEIGHTS.reduce((a, [, w]) => a + w, 0);
  let r = Math.random() * total;
  for (const [cat, w] of WEIGHTS) {
    r -= w;
    if (r <= 0) return cat;
  }
  return 'other';
}
function id(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

interface Actor {
  agent: AgentKind;
  sessionId: string;
  parentSessionId?: string;
  cwd: string;
  project: string;
  tokens: number;
}

/**
 * Modo demo: simula sessões do Claude Code e do Codex passando pelo mesmo
 * caminho dos eventos reais (store.apply), para testar o visual sem agentes.
 */
export class DemoSimulator {
  private stopped = false;
  private readonly timers = new Set<NodeJS.Timeout>();
  private seq = 0;

  constructor(
    private readonly store: SessionStore,
    private readonly concurrency = 7,
    /** Multiplicador de velocidade (2 = duas vezes mais rápido). */
    private readonly speed = 1,
  ) {}

  start(): void {
    for (let i = 0; i < this.concurrency; i++) {
      void this.lane(i);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.stopped) return;
      const t = setTimeout(() => {
        this.timers.delete(t);
        resolve();
      }, ms / this.speed);
      this.timers.add(t);
    });
  }

  private emit(a: Actor, event: EventType, extra: Partial<NormalizedEvent> = {}, meta?: EventMeta): void {
    if (this.stopped) return;
    const ev: NormalizedEvent = {
      agent: a.agent,
      sessionId: a.sessionId,
      ...(a.parentSessionId ? { parentSessionId: a.parentSessionId } : {}),
      cwd: a.cwd,
      project: a.project,
      event,
      toolCategory: 'other',
      ts: Date.now(),
      source: 'demo',
      ...extra,
      ...(meta ? { meta } : {}),
    };
    this.store.apply(ev);
  }

  private bumpContext(a: Actor): void {
    a.tokens = Math.min(190_000, a.tokens + Math.round(rand(800, 6000)));
    this.store.apply({
      kind: 'meta',
      agent: a.agent,
      sessionId: a.sessionId,
      ts: Date.now(),
      meta: { contextTokens: a.tokens, contextWindow: a.agent === 'claude' ? 200_000 : 272_000 },
    });
  }

  private async lane(index: number): Promise<void> {
    await this.sleep(index * rand(900, 2200));
    while (!this.stopped) {
      await this.session(index);
      await this.sleep(rand(3000, 9000));
    }
  }

  private async tool(a: Actor, category = pickCategory()): Promise<void> {
    const toolName = pick(TOOLS[a.agent][category]);
    const toolUseId = id('tool');
    this.emit(a, 'tool_start', { toolName, toolCategory: category }, { toolUseId });
    if (!a.parentSessionId && Math.random() < 0.07) {
      await this.sleep(rand(600, 1500));
      this.emit(a, 'permission_wait', { toolName, toolCategory: category });
      await this.sleep(rand(5000, 11000));
    } else {
      await this.sleep(rand(1800, 7000));
    }
    if (Math.random() < 0.07) this.emit(a, 'error', { toolName, toolCategory: category }, { toolUseId });
    else this.emit(a, 'tool_end', { toolName, toolCategory: category }, { toolUseId });
    this.bumpContext(a);
  }

  private async subagent(parent: Actor): Promise<void> {
    const child: Actor = {
      agent: parent.agent,
      sessionId: id('sub'),
      parentSessionId: parent.sessionId,
      cwd: parent.cwd,
      project: parent.project,
      tokens: 4000,
    };
    this.emit(child, 'subagent_start', {}, { agentType: pick(SUBAGENT_TYPES) });
    await this.sleep(rand(1500, 3000));
    const steps = Math.round(rand(2, 5));
    for (let i = 0; i < steps && !this.stopped; i++) {
      await this.tool(child, pick<ToolCategory>(['read', 'search', 'search', 'bash', 'web', 'read']));
      await this.sleep(rand(600, 2000));
    }
    this.emit(child, 'subagent_stop');
  }

  private async session(lane: number): Promise<void> {
    const agent: AgentKind = (lane + this.seq++) % 3 === 0 ? 'codex' : 'claude';
    const project = pick(PROJECTS);
    const a: Actor = {
      agent,
      sessionId: id(agent === 'claude' ? 'demo-cl' : 'demo-cx'),
      cwd: `/Users/demo/projetos/${project}`,
      project,
      tokens: Math.round(rand(8000, 30000)),
    };
    this.emit(a, 'session_start', {}, { entrypoint: agent === 'claude' ? 'cli' : 'Codex Desktop' });
    await this.sleep(rand(2500, 4500));

    const turns = Math.round(rand(2, 4));
    for (let turn = 0; turn < turns && !this.stopped; turn++) {
      this.emit(a, 'prompt');
      await this.sleep(rand(2000, 5000));

      const steps = Math.round(rand(3, 8));
      let delegated = false;
      for (let i = 0; i < steps && !this.stopped; i++) {
        if (!delegated && Math.random() < 0.14) {
          delegated = true;
          const toolName = agent === 'claude' ? 'Agent' : 'spawn_agent';
          const toolUseId = id('tool');
          this.emit(a, 'tool_start', { toolName, toolCategory: 'plan' }, { toolUseId });
          const n = Math.round(rand(1, 3));
          const kids: Promise<void>[] = [];
          for (let k = 0; k < n; k++) {
            kids.push(this.sleep(k * rand(400, 1200)).then(() => this.subagent(a)));
          }
          await Promise.all(kids);
          this.emit(a, 'tool_end', { toolName, toolCategory: 'plan' }, { toolUseId });
        } else {
          await this.tool(a);
        }
        await this.sleep(rand(900, 3200));
      }

      this.emit(a, 'stop');
      await this.sleep(rand(6000, 14000));
      if (Math.random() < 0.4) {
        this.emit(a, 'waiting_input', {}, { reason: 'idle_prompt' });
        await this.sleep(rand(6000, 14000));
      }
    }
    this.emit(a, 'session_end', {}, { reason: 'other' });
  }
}
