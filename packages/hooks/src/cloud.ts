import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findClaude, findCodex } from './install.js';
import { readConfig, writeConfig, type CloudSourceConfig, type Paths } from './paths.js';

/** Agentes cujas sessões em nuvem o escritório sabe consultar. */
export type CloudAgent = 'codex' | 'claude';
export const CLOUD_AGENTS: readonly CloudAgent[] = ['codex', 'claude'];

interface AgentInfo {
  key: 'codexCloud' | 'claudeCloud';
  label: string;
  cli: string;
  /** Intervalo padrão e mínimo entre consultas, em segundos. */
  everySec: number;
  minEverySec: number;
  /** Como a nuvem chama cada item. */
  one: string;
  many: string;
}

const AGENTS: Record<CloudAgent, AgentInfo> = {
  codex: { key: 'codexCloud', label: 'Codex Cloud', cli: 'Codex', everySec: 30, minEverySec: 10, one: 'tarefa', many: 'tarefas' },
  claude: { key: 'claudeCloud', label: 'Claude Cloud', cli: 'Claude', everySec: 60, minEverySec: 30, one: 'sessão', many: 'sessões' },
};

export function cloudLabel(agent: CloudAgent): string {
  return AGENTS[agent].label;
}

export interface CloudProbe {
  ok: boolean;
  /** Quantos itens a conta lista agora (quando a consulta funciona). */
  tasks?: number;
  error?: string;
}

/** Consulta a nuvem uma vez (injetável nos testes). */
export type ProbeCloud = (bin: string) => CloudProbe;

function failure(err: unknown): CloudProbe {
  const e = err as { stderr?: string | Buffer; message?: string };
  const text = String(e.stderr ?? '').trim().split('\n').pop() || e.message || 'falha ao consultar';
  return { ok: false, error: text.slice(0, 200) };
}

export const probeCodexCloud: ProbeCloud = (bin) => {
  try {
    const out = execFileSync(bin, ['cloud', 'list', '--json', '--limit', '20'], {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(out) as { tasks?: unknown };
    return { ok: true, tasks: Array.isArray(parsed.tasks) ? parsed.tasks.length : 0 };
  } catch (err) {
    return failure(err);
  }
};

/**
 * A mesma chamada que o servidor faz (veja packages/server/src/claude-cloud.ts):
 * `/list-agents` com o recurso experimental de sessões entre máquinas ligado.
 */
export const probeClaudeCloud: ProbeCloud = (bin) => {
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_HARBOR_KITE: '1', CLAUDE_CODE_HARBOR_KITE_CLOUD: '1' };
    delete env.CLAUDECODE;
    // Mesma pasta que o servidor usa: o escritório ignora processos da CLI que rodam nela.
    const cwd = join(tmpdir(), 'agent-office-cloud-probe');
    mkdirSync(cwd, { recursive: true });
    const out = execFileSync(
      bin,
      ['-p', '/list-agents', '--output-format', 'json', '--strict-mcp-config', '--no-session-persistence', '--setting-sources', ''],
      { encoding: 'utf8', timeout: 45_000, stdio: ['ignore', 'pipe', 'pipe'], env, cwd },
    );
    for (const line of out.split('\n')) {
      if (!line.trim().startsWith('{')) continue;
      let parsed: { type?: string; is_error?: boolean; result?: unknown };
      try {
        parsed = JSON.parse(line) as typeof parsed;
      } catch {
        continue;
      }
      if (parsed.type !== 'result') continue;
      if (parsed.is_error || typeof parsed.result !== 'string') return { ok: false, error: 'a CLI do Claude devolveu um erro' };
      if (/cloud session list could not be fetched/i.test(parsed.result)) {
        return { ok: false, error: 'a lista de sessões em nuvem não pôde ser consultada agora' };
      }
      return { ok: true, tasks: parsed.result.split('\n').filter((l) => /\s·\s+cloud\s*$/.test(l)).length };
    }
    return { ok: false, error: 'saída inesperada da CLI do Claude' };
  } catch (err) {
    return failure(err);
  }
};

function findBin(paths: Paths, agent: CloudAgent): string | null {
  const found = agent === 'codex' ? findCodex(paths)?.path : findClaude()?.path;
  if (!found) return null;
  try {
    // O serviço roda com um PATH mínimo: guarda o caminho real do executável.
    return realpathSync(found);
  } catch {
    return found;
  }
}

export function currentCloud(paths: Paths, agent: CloudAgent = 'codex'): CloudSourceConfig {
  const c = readConfig(paths)[AGENTS[agent].key];
  return {
    enabled: c?.enabled === true,
    ...(typeof c?.bin === 'string' && c.bin ? { bin: c.bin } : {}),
    ...(c?.everySec ? { everySec: c.everySec } : {}),
  };
}

export interface EnableCloudResult {
  ok: boolean;
  detail: string;
  cloud?: CloudSourceConfig;
}

/**
 * Liga as sessões em nuvem de um agente. Só liga se a CLI existir e a consulta
 * funcionar (conta conectada) — assim o servidor não fica tentando à toa.
 */
export function enableCloud(
  paths: Paths,
  agent: CloudAgent,
  opts: { everySec?: number } = {},
  deps: { bin?: string | null; probe?: ProbeCloud } = {},
): EnableCloudResult {
  const info = AGENTS[agent];
  const bin = deps.bin !== undefined ? deps.bin : findBin(paths, agent);
  if (!bin) return { ok: false, detail: `CLI do ${info.cli} não encontrada nesta máquina` };
  const probe = (deps.probe ?? (agent === 'codex' ? probeCodexCloud : probeClaudeCloud))(bin);
  if (!probe.ok) {
    return { ok: false, detail: `a consulta falhou: ${probe.error ?? 'erro desconhecido'} — confira o login do ${info.cli}` };
  }
  const prev = currentCloud(paths, agent);
  const cloud: CloudSourceConfig = {
    enabled: true,
    bin,
    everySec: opts.everySec && opts.everySec >= info.minEverySec ? opts.everySec : (prev.everySec ?? info.everySec),
  };
  writeConfig(paths, { ...readConfig(paths), [info.key]: cloud });
  const n = probe.tasks ?? 0;
  const found = n === 0 ? `nenhuma ${info.one} na conta agora` : `${n} ${n === 1 ? info.one : info.many} na conta`;
  return { ok: true, detail: `${describeCloud(cloud, agent)} · ${found}`, cloud };
}

export function disableCloud(paths: Paths, agent: CloudAgent = 'codex'): void {
  writeConfig(paths, { ...readConfig(paths), [AGENTS[agent].key]: { ...currentCloud(paths, agent), enabled: false } });
}

export function describeCloud(c: CloudSourceConfig, agent: CloudAgent = 'codex'): string {
  if (!c.enabled) return 'desligado';
  return `consulta o ${AGENTS[agent].label} a cada ${c.everySec ?? AGENTS[agent].everySec}s`;
}
