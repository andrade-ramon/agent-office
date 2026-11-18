import type { AgentKind, EventMeta, EventType, NormalizedEvent, ToolCategory } from './schema.js';
import { CLAUDE_CLOUD_ENTRYPOINT, CLAUDE_CLOUD_URL } from './claude-cloud.js';
import { CLOUD_ENTRYPOINT } from './codex-cloud.js';
import type { SessionStore } from './state.js';
import type { UsageLedger } from './usage.js';

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

const MODELS: Record<AgentKind, string[]> = {
  claude: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-haiku-5-5'],
  codex: ['gpt-6.1-sol'],
};
const DAY_MS = 24 * 60 * 60 * 1000;

const SUBAGENT_TYPES = ['Explore', 'general-purpose', 'code-reviewer', 'Plan'];

const TITLES = [
  'Corrigir cálculo de frete no checkout',
  'Migrar autenticação para OAuth',
  'Investigar lentidão no relatório mensal',
  'Adicionar testes ao módulo de pagamentos',
  'Atualizar dependências e corrigir build',
  'Refatorar tela de cadastro',
  'Revisar pipeline de deploy',
  'Documentar a API pública',
];
const SUBAGENT_TASKS = [
  'Mapear rotas da API',
  'Procurar usos da função antiga',
  'Revisar mudanças do diff',
  'Ler a documentação da biblioteca',
  'Rodar e resumir os testes',
];

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
    /** Painel de dados: o demo inventa um histórico e segue somando. */
    private readonly usage?: UsageLedger,
  ) {}

  start(): void {
    this.seedUsage();
    for (let i = 0; i < this.concurrency; i++) {
      void this.lane(i);
    }
    // Duas tarefas "na nuvem" por vez, para a bancada da nuvem não ficar vazia.
    for (let i = 0; i < 2; i++) void this.cloudLane(i);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  /** Duas semanas de números plausíveis, para o telão não começar zerado. */
  private seedUsage(): void {
    const usage = this.usage;
    if (!usage) return;
    const now = Date.now();
    for (let back = 13; back >= 0; back--) {
      const ts = now - back * DAY_MS;
      const weekday = new Date(ts).getDay();
      // Fim de semana mais calmo; hoje ainda está pela metade.
      const load = (weekday === 0 || weekday === 6 ? 0.25 : 1) * (back === 0 ? 0.4 : 1) * rand(0.6, 1.3);
      for (const agent of ['claude', 'codex'] as const) {
        const share = load * (agent === 'claude' ? 1 : 0.45);
        const tokens = {
          in: rand(300_000, 900_000) * share,
          out: rand(200_000, 700_000) * share,
          cr: rand(40_000_000, 110_000_000) * share,
          cw: agent === 'claude' ? rand(2_000_000, 7_000_000) * share : 0,
        };
        let total = 0;
        const models = MODELS[agent];
        for (const [metric, value] of Object.entries(tokens)) {
          usage.record(agent, ts, metric, value);
          total += Math.round(value);
          // por modelo e tipo de cobrança, para o custo estimado
          models.forEach((model, i) => usage.record(agent, ts, `model:${model}|${metric}`, (value * (models.length - i)) / ((models.length * (models.length + 1)) / 2)));
        }
        const tools = rand(500, 1400) * share;
        const weight = WEIGHTS.reduce((a, [, w]) => a + w, 0);
        for (const [cat, w] of WEIGHTS) usage.record(agent, ts, `tool:${cat}`, (tools * w) / weight);
        usage.record(agent, ts, 'tools', tools);
        usage.record(agent, ts, 'prompts', rand(30, 80) * share);
        usage.record(agent, ts, 'sessions', rand(6, 16) * share);
        usage.record(agent, ts, 'subagents', rand(8, 30) * share);
        usage.record(agent, ts, 'errors', rand(4, 20) * share);
        usage.record(agent, ts, 'active', rand(2, 6) * 3_600_000 * share);
        usage.record(agent, ts, 'subActive', rand(0.5, 2) * 3_600_000 * share);
        for (const project of PROJECTS) usage.record(agent, ts, `project:${project}`, (total / PROJECTS.length) * rand(0.3, 1.7));
      }
    }
  }

  /** Soma no painel de dados. Sessões na nuvem ficam fora, como no uso real (não têm transcript). */
  private count(a: Actor, metric: string, value = 1): void {
    if (this.stopped || !a.cwd) return;
    this.usage?.record(a.agent, Date.now(), metric, value);
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
    if (event === 'prompt') this.count(a, 'prompts');
    else if (event === 'error') this.count(a, 'errors');
    else if (event === 'session_start') this.count(a, 'sessions');
    else if (event === 'subagent_start') this.count(a, 'subagents');
    else if (event === 'tool_start') {
      this.count(a, 'tools');
      this.count(a, `tool:${ev.toolCategory}`);
    }
  }

  private bumpContext(a: Actor): void {
    const grew = Math.round(rand(800, 6000));
    const spent = { in: rand(200, 1500), out: rand(150, 1800), cr: a.tokens, cw: a.agent === 'claude' ? grew : 0 };
    let total = 0;
    for (const [metric, value] of Object.entries(spent)) {
      this.count(a, metric, value);
      this.count(a, `model:${MODELS[a.agent][0]!}|${metric}`, value);
      total += Math.round(value);
    }
    this.count(a, `project:${a.project}`, total);
    a.tokens = Math.min(190_000, a.tokens + grew);
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
    const began = Date.now();
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
    this.count(a, a.parentSessionId ? 'subActive' : 'active', Date.now() - began);
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
    this.emit(child, 'subagent_start', {}, { agentType: pick(SUBAGENT_TYPES), title: pick(SUBAGENT_TASKS) });
    await this.sleep(rand(1500, 3000));
    const steps = Math.round(rand(2, 5));
    for (let i = 0; i < steps && !this.stopped; i++) {
      await this.tool(child, pick<ToolCategory>(['read', 'search', 'search', 'bash', 'web', 'read']));
      await this.sleep(rand(600, 2000));
    }
    this.emit(child, 'subagent_stop');
  }

  private async cloudLane(index: number): Promise<void> {
    await this.sleep(2000 + index * rand(6000, 12000));
    while (!this.stopped) {
      await this.cloudTask(index % 2 === 0 ? 'codex' : 'claude');
      await this.sleep(rand(6000, 16000));
    }
  }

  /**
   * Sessão na nuvem: só se sabe que está rodando. O Codex informa, no fim, o
   * tamanho da alteração; o Claude pode parar para esperar uma resposta.
   */
  private async cloudTask(agent: AgentKind): Promise<void> {
    const codex = agent === 'codex';
    const entrypoint = codex ? CLOUD_ENTRYPOINT : CLAUDE_CLOUD_ENTRYPOINT;
    const a: Actor = {
      agent,
      sessionId: id('demo-cloud'),
      cwd: '',
      project: codex ? `demo/${pick(PROJECTS)}` : entrypoint,
      tokens: 0,
    };
    const meta: EventMeta = {
      entrypoint,
      remote: true,
      title: pick(TITLES),
      url: codex ? 'https://chatgpt.com/codex' : CLAUDE_CLOUD_URL,
    };
    this.emit(a, 'session_start', {}, meta);
    this.emit(a, 'tool_start', { toolName: entrypoint }, meta);
    await this.sleep(rand(25_000, 60_000));
    if (!codex && Math.random() < 0.5) {
      this.emit(a, 'waiting_input', {}, { reason: 'requires_action' });
      await this.sleep(rand(8000, 16_000));
      this.emit(a, 'prompt');
      this.emit(a, 'tool_start', { toolName: entrypoint });
      await this.sleep(rand(15_000, 30_000));
    }
    const changes = { files: Math.round(rand(1, 9)), added: Math.round(rand(8, 240)), removed: Math.round(rand(0, 90)) };
    this.emit(a, 'stop', {}, codex ? { changes } : undefined);
    await this.sleep(rand(12_000, 22_000));
    this.emit(a, 'session_end', {}, { reason: 'other' });
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
    this.emit(a, 'session_start', {}, { entrypoint: agent === 'claude' ? 'cli' : 'Codex Desktop', title: pick(TITLES) });
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
