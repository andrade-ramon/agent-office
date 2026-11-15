import { execFileSync } from 'node:child_process';
import { findCodex } from './install.js';
import { readConfig, writeConfig, type CodexCloudConfig, type Paths } from './paths.js';

export interface CloudProbe {
  ok: boolean;
  /** Quantas tarefas a conta lista agora (quando a consulta funciona). */
  tasks?: number;
  error?: string;
}

/** Consulta a nuvem do Codex uma vez (injetável nos testes). */
export type ProbeCloud = (bin: string) => CloudProbe;

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
    const e = err as { stderr?: string | Buffer; message?: string };
    const text = String(e.stderr ?? '').trim().split('\n').pop() || e.message || 'falha ao consultar';
    return { ok: false, error: text.slice(0, 200) };
  }
};

export function currentCloud(paths: Paths): CodexCloudConfig {
  const c = readConfig(paths).codexCloud;
  return {
    enabled: c?.enabled === true,
    ...(typeof c?.bin === 'string' && c.bin ? { bin: c.bin } : {}),
    ...(c?.everySec ? { everySec: c.everySec } : {}),
  };
}

export interface EnableCloudResult {
  ok: boolean;
  detail: string;
  cloud?: CodexCloudConfig;
}

/**
 * Liga as sessões do Codex na nuvem. Só liga se a CLI do Codex existir e a
 * consulta funcionar (conta conectada) — assim o servidor não fica tentando à toa.
 */
export function enableCloud(
  paths: Paths,
  opts: { everySec?: number } = {},
  deps: { bin?: string | null; probe?: ProbeCloud } = {},
): EnableCloudResult {
  const bin = deps.bin !== undefined ? deps.bin : (findCodex(paths)?.path ?? null);
  if (!bin) return { ok: false, detail: 'CLI do Codex não encontrada nesta máquina' };
  const probe = (deps.probe ?? probeCodexCloud)(bin);
  if (!probe.ok) {
    return { ok: false, detail: `"codex cloud list" falhou: ${probe.error ?? 'erro desconhecido'} — confira o login do Codex` };
  }
  const prev = currentCloud(paths);
  const cloud: CodexCloudConfig = {
    enabled: true,
    bin,
    everySec: opts.everySec && opts.everySec >= 10 ? opts.everySec : (prev.everySec ?? 30),
  };
  writeConfig(paths, { ...readConfig(paths), codexCloud: cloud });
  const n = probe.tasks ?? 0;
  return {
    ok: true,
    detail: `${describeCloud(cloud)} · ${n === 0 ? 'nenhuma tarefa na conta agora' : `${n} tarefa${n === 1 ? '' : 's'} na conta`}`,
    cloud,
  };
}

export function disableCloud(paths: Paths): void {
  writeConfig(paths, { ...readConfig(paths), codexCloud: { ...currentCloud(paths), enabled: false } });
}

export function describeCloud(c: CodexCloudConfig): string {
  if (!c.enabled) return 'desligado';
  return `consulta o Codex Cloud a cada ${c.everySec ?? 30}s`;
}
