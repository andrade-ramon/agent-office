import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_PORT = 4747;
export const DEMO_PORT = 4748;
export const HOST = '127.0.0.1';

export interface OfficeConfig {
  port: number;
  /** Minutos sem eventos até a sessão virar "idle". */
  idleAfterMin: number;
  /** Minutos sem eventos até a sessão ser considerada encerrada. */
  endAfterMin: number;
  /** Mostra o assunto (título) das sessões. `false` mantém metadados estritos. */
  titles: boolean;
}

export const DEFAULT_CONFIG: OfficeConfig = {
  port: DEFAULT_PORT,
  idleAfterMin: 5,
  endAfterMin: 30,
  titles: true,
};

/** Diretório de dados do agent-office (`~/.agent-office`). */
export function officeHome(): string {
  return process.env.AGENT_OFFICE_HOME || join(homedir(), '.agent-office');
}

function positive(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Lê `~/.agent-office/config.json` (opcional) e variáveis de ambiente. */
export function loadConfig(home: string = officeHome()): OfficeConfig {
  let file: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    if (raw && typeof raw === 'object') file = raw as Record<string, unknown>;
  } catch {
    /* sem arquivo de configuração: usa os padrões */
  }
  return {
    port: positive(process.env.AGENT_OFFICE_PORT) ?? positive(file.port) ?? DEFAULT_CONFIG.port,
    idleAfterMin: positive(process.env.AGENT_OFFICE_IDLE_MIN) ?? positive(file.idleAfterMin) ?? DEFAULT_CONFIG.idleAfterMin,
    endAfterMin: positive(process.env.AGENT_OFFICE_END_MIN) ?? positive(file.endAfterMin) ?? DEFAULT_CONFIG.endAfterMin,
    titles: process.env.AGENT_OFFICE_TITLES ? process.env.AGENT_OFFICE_TITLES !== '0' : file.titles !== false,
  };
}
