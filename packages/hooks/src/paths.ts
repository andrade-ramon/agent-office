import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 4747;
export const HOST = '127.0.0.1';
/** Trecho presente em todo comando de hook instalado por nós. */
export const HOOK_MARKER = 'agent-office-hook';

const here = dirname(fileURLToPath(import.meta.url));

export interface Paths {
  /** `~/.agent-office` */
  home: string;
  bin: string;
  backups: string;
  logs: string;
  config: string;
  installState: string;
  pidFile: string;
  db: string;
  hookScript: string;
  hookLauncher: string;
  claudeHome: string;
  claudeSettings: string;
  codexHome: string;
  codexHooks: string;
  codexConfig: string;
  /** Raiz do repositório (packages/hooks/dist → ../../..). */
  repoRoot: string;
  serverEntry: string;
  webDist: string;
  hookSource: string;
}

export function getPaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.AGENT_OFFICE_HOME || join(homedir(), '.agent-office');
  const claudeHome = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const codexHome = env.CODEX_HOME || join(homedir(), '.codex');
  const repoRoot = resolve(here, '..', '..', '..');
  const win = process.platform === 'win32';
  return {
    home,
    bin: join(home, 'bin'),
    backups: join(home, 'backups'),
    logs: join(home, 'logs'),
    config: join(home, 'config.json'),
    installState: join(home, 'install-state.json'),
    pidFile: join(home, 'server.pid'),
    db: join(home, 'agent-office.db'),
    hookScript: join(home, 'bin', 'agent-office-hook.mjs'),
    hookLauncher: join(home, 'bin', win ? 'agent-office-hook.cmd' : 'agent-office-hook'),
    claudeHome,
    claudeSettings: join(claudeHome, 'settings.json'),
    codexHome,
    codexHooks: join(codexHome, 'hooks.json'),
    codexConfig: join(codexHome, 'config.toml'),
    repoRoot,
    serverEntry: join(repoRoot, 'packages', 'server', 'dist', 'index.js'),
    webDist: join(repoRoot, 'packages', 'web', 'dist'),
    hookSource: resolve(here, '..', 'hook', 'agent-office-hook.mjs'),
  };
}

export interface VoiceAlertConfig {
  enabled: boolean;
  /** O que falar (normalmente o seu nome). */
  text: string;
  /** Segundos entre repetições. */
  everySec?: number;
  /** Segundos de espera antes do primeiro chamado. */
  delaySec?: number;
  /** Voz do sistema (vazio = padrão). */
  voice?: string;
}

export interface OfficeConfig {
  port: number;
  idleAfterMin?: number;
  endAfterMin?: number;
  titles?: boolean;
  voiceAlert?: VoiceAlertConfig;
}

export function readConfig(paths: Paths): OfficeConfig {
  try {
    const raw = JSON.parse(readFileSync(paths.config, 'utf8')) as Partial<OfficeConfig>;
    const port = Number(raw.port);
    return { ...raw, port: port > 0 ? port : DEFAULT_PORT };
  } catch {
    return { port: DEFAULT_PORT };
  }
}

export function writeConfig(paths: Paths, config: OfficeConfig): void {
  mkdirSync(paths.home, { recursive: true });
  writeFileSync(paths.config, `${JSON.stringify(config, null, 2)}\n`);
}

/** Porta efetiva: variável de ambiente > config.json > padrão. */
export function resolvePort(paths: Paths, env: NodeJS.ProcessEnv = process.env): number {
  const fromEnv = Number(env.AGENT_OFFICE_PORT);
  if (fromEnv > 0) return fromEnv;
  return readConfig(paths).port;
}

export function ensureDirs(paths: Paths): void {
  for (const dir of [paths.home, paths.bin, paths.backups, paths.logs]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}
