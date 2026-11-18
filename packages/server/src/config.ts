import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parsePrices, parseUsdBrl, type PriceOverrides } from './pricing.js';

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
  sound?: 'voice' | 'siren' | 'beep';
  text: string;
  everySec: number;
  delaySec: number;
  voice?: string;
}

/**
 * Lê uma seção do config.json. Relê o arquivo só quando ele muda, para que os
 * comandos da CLI (`alert on/off`, `cloud on/off`) valham sem reiniciar o servidor.
 */
function sectionReader<T>(home: string, key: string, off: T, parse: (o: Record<string, unknown>) => T): () => T {
  return valueReader(home, key, off, (v) => (v && typeof v === 'object' && !Array.isArray(v) ? parse(v as Record<string, unknown>) : off));
}

function valueReader<T>(home: string, key: string, off: T, parse: (v: unknown) => T): () => T {
  const file = join(home, 'config.json');
  let cached = off;
  let mtimeMs = -1;
  return () => {
    try {
      const st = statSync(file);
      if (st.mtimeMs === mtimeMs) return cached;
      mtimeMs = st.mtimeMs;
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[key] : undefined;
      cached = parse(v);
      return cached;
    } catch {
      mtimeMs = -1;
      return (cached = off);
    }
  };
}

export function voiceAlertReader(home: string = officeHome()): () => VoiceAlertConfig {
  const off: VoiceAlertConfig = { enabled: false, text: '', everySec: 8, delaySec: 3 };
  return sectionReader(home, 'voiceAlert', off, (o) => ({
    enabled: o.enabled === true,
    ...(o.sound === 'siren' || o.sound === 'beep' ? { sound: o.sound } : {}),
    text: typeof o.text === 'string' ? o.text : '',
    everySec: positive(o.everySec) ?? off.everySec,
    delaySec: typeof o.delaySec === 'number' && o.delaySec >= 0 ? o.delaySec : off.delaySec,
    ...(typeof o.voice === 'string' && o.voice ? { voice: o.voice } : {}),
  }));
}

export interface CodexCloudConfig {
  enabled: boolean;
  bin: string;
  everySec: number;
}

function cloudReader(home: string, key: string, everySec: number): () => CodexCloudConfig {
  const off: CodexCloudConfig = { enabled: false, bin: '', everySec };
  return sectionReader(home, key, off, (o) => ({
    enabled: o.enabled === true,
    bin: typeof o.bin === 'string' ? o.bin : '',
    everySec: positive(o.everySec) ?? off.everySec,
  }));
}

/** Seção "codexCloud": sessões do Codex que rodam na nuvem (opcional). */
export function codexCloudReader(home: string = officeHome()): () => CodexCloudConfig {
  return cloudReader(home, 'codexCloud', 30);
}

/** Seção "claudeCloud": sessões do Claude Code que rodam na nuvem (opcional, experimental). */
export function claudeCloudReader(home: string = officeHome()): () => CodexCloudConfig {
  return cloudReader(home, 'claudeCloud', 60);
}

export interface PeerConfig {
  /** Nome exibido no escritório (ex.: "macbook-casa"). */
  name: string;
  /** Destino SSH (`host` ou `usuario@host`): o servidor abre o túnel sozinho. */
  ssh?: string;
  /** Porta do agent-office na outra máquina. */
  remotePort: number;
  /** Alternativa ao SSH: endereço local de um túnel que você mesmo mantém. */
  url?: string;
}

const PEER_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
/** `host` ou `usuario@host`; nunca começa com "-" (seria lido pelo ssh como opção). */
const SSH_TARGET = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,127}$/;

export function isLoopbackUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === 'http:' || u.protocol === 'ws:') && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Valida uma entrada de `peers`; devolve null se não for utilizável. */
export function parsePeer(raw: unknown): PeerConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!PEER_NAME.test(name)) return null;
  const ssh = typeof o.ssh === 'string' && SSH_TARGET.test(o.ssh) ? o.ssh : undefined;
  const url = typeof o.url === 'string' && isLoopbackUrl(o.url) ? o.url : undefined;
  if (!ssh && !url) return null;
  return { name, remotePort: positive(o.remotePort) ?? DEFAULT_PORT, ...(ssh ? { ssh } : {}), ...(!ssh && url ? { url } : {}) };
}

/** Seção "peers": outros computadores cujas sessões este escritório espelha. */
export function peersReader(home: string = officeHome()): () => PeerConfig[] {
  const none: PeerConfig[] = [];
  return valueReader(home, 'peers', none, (v) => {
    if (!Array.isArray(v)) return none;
    const seen = new Set<string>();
    const peers: PeerConfig[] = [];
    for (const item of v) {
      const peer = parsePeer(item);
      if (!peer || seen.has(peer.name)) continue;
      seen.add(peer.name);
      peers.push(peer);
    }
    return peers;
  });
}

/** Seção "prices": preços por modelo (US$ por milhão de tokens) que completam ou corrigem a tabela embutida. */
export function pricesReader(home: string = officeHome()): () => PriceOverrides {
  return valueReader(home, 'prices', parsePrices(undefined), parsePrices);
}

/** "usdBrl": câmbio (reais por dólar) usado no custo em reais; sem ele vale a referência embutida. */
export function usdBrlReader(home: string = officeHome()): () => number | undefined {
  return valueReader<number | undefined>(home, 'usdBrl', undefined, parseUsdBrl);
}

/** "usdBrlAuto": busca a cotação do dólar no Banco Central (opcional; é uma requisição para fora). */
export function usdBrlAutoReader(home: string = officeHome()): () => boolean {
  return valueReader(home, 'usdBrlAuto', false, (v) => v === true);
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
