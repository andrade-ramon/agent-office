import { readFileSync, statSync } from 'node:fs';
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

export interface VoiceAlertConfig {
  enabled: boolean;
  text: string;
  everySec: number;
  delaySec: number;
  voice?: string;
}

/**
 * Lê a seção "voiceAlert" do config.json. Relê o arquivo só quando ele muda,
 * para que `agent-office alert on/off` valha sem reiniciar o servidor.
 */
export function voiceAlertReader(home: string = officeHome()): () => VoiceAlertConfig {
  const file = join(home, 'config.json');
  const off: VoiceAlertConfig = { enabled: false, text: '', everySec: 8, delaySec: 3 };
  let cached = off;
  let mtimeMs = -1;
  return () => {
    try {
      const st = statSync(file);
      if (st.mtimeMs === mtimeMs) return cached;
      mtimeMs = st.mtimeMs;
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).voiceAlert : undefined;
      if (!v || typeof v !== 'object') return (cached = off);
      const o = v as Record<string, unknown>;
      cached = {
        enabled: o.enabled === true,
        text: typeof o.text === 'string' ? o.text : '',
        everySec: positive(o.everySec) ?? off.everySec,
        delaySec: typeof o.delaySec === 'number' && o.delaySec >= 0 ? o.delaySec : off.delaySec,
        ...(typeof o.voice === 'string' && o.voice ? { voice: o.voice } : {}),
      };
      return cached;
    } catch {
      mtimeMs = -1;
      return (cached = off);
    }
  };
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
