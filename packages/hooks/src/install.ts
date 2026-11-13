import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  addHooks,
  countInstalled,
  deepEqual,
  HooksConfigError,
  isObject,
  removeHooks,
  serialize,
  type HookHandler,
  type InstallRecord,
  type JsonObject,
} from './hooks-config.js';
import { ensureDirs, HOOK_MARKER, type Paths } from './paths.js';

export type AgentId = 'claude' | 'codex';

// ───────────────────────── eventos ─────────────────────────

interface EventSpec {
  event: string;
  /** Roda em segundo plano (não bloqueia o agente nem por milissegundos). */
  async: boolean;
  timeout: number;
  /** Versão mínima do Codex que conhece o evento. */
  min?: [number, number, number];
}

/**
 * Hooks do Claude Code (https://code.claude.com/docs/en/hooks).
 * Eventos de ferramenta rodam com `async: true`; os de ciclo de vida são
 * síncronos com timeout curto para garantir a entrega antes de o processo sair.
 */
export const CLAUDE_EVENTS: EventSpec[] = [
  { event: 'SessionStart', async: false, timeout: 5 },
  { event: 'UserPromptSubmit', async: true, timeout: 5 },
  { event: 'PreToolUse', async: true, timeout: 5 },
  { event: 'PostToolUse', async: true, timeout: 5 },
  { event: 'PostToolUseFailure', async: true, timeout: 5 },
  { event: 'PermissionRequest', async: true, timeout: 5 },
  { event: 'Notification', async: true, timeout: 5 },
  { event: 'SubagentStart', async: true, timeout: 5 },
  { event: 'SubagentStop', async: true, timeout: 5 },
  { event: 'Stop', async: false, timeout: 5 },
  { event: 'StopFailure', async: false, timeout: 5 },
  { event: 'SessionEnd', async: false, timeout: 5 },
];

/** Hooks do Codex (`~/.codex/hooks.json`), com a versão que introduziu cada evento. */
export const CODEX_EVENTS: EventSpec[] = [
  { event: 'SessionStart', async: true, timeout: 5, min: [0, 114, 0] },
  { event: 'UserPromptSubmit', async: true, timeout: 5, min: [0, 116, 0] },
  { event: 'PreToolUse', async: true, timeout: 5, min: [0, 117, 0] },
  { event: 'PostToolUse', async: true, timeout: 5, min: [0, 117, 0] },
  { event: 'PermissionRequest', async: true, timeout: 5, min: [0, 122, 0] },
  { event: 'Stop', async: true, timeout: 5, min: [0, 114, 0] },
  { event: 'SubagentStart', async: true, timeout: 5, min: [0, 133, 0] },
  { event: 'SubagentStop', async: true, timeout: 5, min: [0, 133, 0] },
  // SessionEnd e Interrupt aceitam no máximo 3 s e SessionEnd é sempre síncrono.
  { event: 'SessionEnd', async: false, timeout: 2, min: [0, 145, 0] },
  { event: 'Interrupt', async: true, timeout: 2, min: [0, 150, 0] },
];

const CODEX_ASYNC_MIN: [number, number, number] = [0, 148, 0];
/** Sem versão conhecida, assume apenas o conjunto estável inicial. */
const CODEX_FALLBACK_VERSION: [number, number, number] = [0, 124, 0];

export type Version = [number, number, number];

export function parseVersion(text: string | undefined | null): Version | null {
  const m = text?.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function versionGte(a: Version, b: Version): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return true;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Comando gravado nas configurações. Sempre termina com código 0. */
export function hookCommand(launcher: string, agent: AgentId, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `"${launcher}" ${agent}`;
  const q = shellQuote(launcher);
  return `[ -x ${q} ] && ${q} ${agent} || true`;
}

export function claudeHandlers(launcher: string, platform?: NodeJS.Platform): Record<string, HookHandler> {
  const command = hookCommand(launcher, 'claude', platform);
  const out: Record<string, HookHandler> = {};
  for (const spec of CLAUDE_EVENTS) {
    out[spec.event] = { type: 'command', command, timeout: spec.timeout, ...(spec.async ? { async: true } : {}) };
  }
  return out;
}

export function codexHandlers(
  launcher: string,
  version: Version | null,
  platform?: NodeJS.Platform,
): Record<string, HookHandler> {
  const v = version ?? CODEX_FALLBACK_VERSION;
  const allowAsync = versionGte(v, CODEX_ASYNC_MIN);
  const command = hookCommand(launcher, 'codex', platform);
  const out: Record<string, HookHandler> = {};
  for (const spec of CODEX_EVENTS) {
    if (spec.min && !versionGte(v, spec.min)) continue;
    out[spec.event] = {
      type: 'command',
      command,
      timeout: spec.timeout,
      ...(spec.async && allowAsync ? { async: true } : {}),
    };
  }
  return out;
}

// ───────────────────────── script de hook ─────────────────────────

export function launcherContent(node: string, hookScript: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return `@echo off\r\n"${node}" "${hookScript}" %* 2>nul\r\nexit /b 0\r\n`;
  }
  return `#!/bin/sh
# agent-office — lançador do hook. Fail-open: sempre sai com 0 e nunca imprime nada.
NODE=${shellQuote(node)}
if [ ! -x "$NODE" ]; then NODE="$(command -v node 2>/dev/null)"; fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then exit 0; fi
"$NODE" ${shellQuote(hookScript)} "$@" 2>/dev/null
exit 0
`;
}

/** Copia o script de hook e gera o lançador em `~/.agent-office/bin`. */
export function installHookFiles(paths: Paths, node: string = process.execPath): { changed: boolean } {
  ensureDirs(paths);
  let changed = false;
  const source = readFileSync(paths.hookSource, 'utf8');
  const current = existsSync(paths.hookScript) ? readFileSync(paths.hookScript, 'utf8') : null;
  if (current !== source) {
    writeFileSync(paths.hookScript, source);
    changed = true;
  }
  chmodSync(paths.hookScript, 0o755);

  const launcher = launcherContent(node, paths.hookScript);
  const currentLauncher = existsSync(paths.hookLauncher) ? readFileSync(paths.hookLauncher, 'utf8') : null;
  if (currentLauncher !== launcher) {
    writeFileSync(paths.hookLauncher, launcher);
    changed = true;
  }
  chmodSync(paths.hookLauncher, 0o755);
  return { changed };
}

export function removeHookFiles(paths: Paths): void {
  for (const f of [paths.hookScript, paths.hookLauncher]) {
    rmSync(f, { force: true });
  }
}

// ───────────────────────── estado da instalação ─────────────────────────

interface TargetState {
  file: string;
  /** O arquivo não existia antes de nós. */
  createdFile: boolean;
  record: InstallRecord;
  /** Cópia intocada do arquivo original (primeira instalação). */
  originalBackup?: string;
  installedAt: number;
}

type InstallState = Partial<Record<AgentId, TargetState>>;

function readState(paths: Paths): InstallState {
  try {
    const raw: unknown = JSON.parse(readFileSync(paths.installState, 'utf8'));
    return isObject(raw) ? (raw as unknown as InstallState) : {};
  } catch {
    return {};
  }
}

function writeState(paths: Paths, state: InstallState): void {
  ensureDirs(paths);
  writeFileSync(paths.installState, `${JSON.stringify(state, null, 2)}\n`);
}

// ───────────────────────── arquivos ─────────────────────────

function realTarget(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

function writeAtomic(file: string, content: string): void {
  const target = realTarget(file);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.agent-office.tmp`;
  writeFileSync(tmp, content);
  try {
    chmodSync(tmp, statSync(target).mode & 0o777);
  } catch {
    /* arquivo novo: mantém o modo padrão */
  }
  renameSync(tmp, target);
}

function stamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

function backup(paths: Paths, id: AgentId, file: string): string {
  ensureDirs(paths);
  const dest = join(paths.backups, `${id}-${basename(file)}.${stamp()}.bak`);
  copyFileSync(file, dest);
  pruneBackups(paths, `${id}-${basename(file)}.`);
  return dest;
}

function pruneBackups(paths: Paths, prefix: string, keep = 20): void {
  try {
    const files = readdirSync(paths.backups)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.bak'))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      rmSync(join(paths.backups, f), { force: true });
    }
  } catch {
    /* melhor esforço */
  }
}

function parseConfig(text: string, file: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new HooksConfigError(`${file} não é um JSON válido (${(err as Error).message}); nada foi alterado`);
  }
  if (!isObject(parsed)) throw new HooksConfigError(`${file} não contém um objeto JSON; nada foi alterado`);
  return parsed as JsonObject;
}

// ───────────────────────── connect / disconnect ─────────────────────────

export interface ConnectResult {
  agent: AgentId;
  file: string;
  status: 'installed' | 'updated' | 'unchanged' | 'error';
  detail: string;
  events: string[];
  backup?: string;
}

/** Mescla nossos hooks no arquivo de configuração do agente. */
export function connectTarget(
  paths: Paths,
  agent: AgentId,
  file: string,
  handlers: Record<string, HookHandler>,
): ConnectResult {
  const events = Object.keys(handlers);
  try {
    const existed = existsSync(file);
    const text = existed ? readFileSync(file, 'utf8') : undefined;
    const config = text !== undefined && text.trim() !== '' ? parseConfig(text, file) : {};
    const state = readState(paths);
    const prev = state[agent]?.file === file ? state[agent] : undefined;
    const hadOurs = countInstalled(config, events, HOOK_MARKER) > 0;

    const { config: next, record, changed } = addHooks(config, handlers, HOOK_MARKER, prev?.record);
    if (!changed) {
      if (!prev) {
        state[agent] = { file, createdFile: false, record, installedAt: Date.now() };
        writeState(paths, state);
      }
      return { agent, file, status: 'unchanged', detail: 'hooks já instalados', events };
    }

    let backupPath: string | undefined;
    let originalBackup = prev?.originalBackup;
    if (existed) {
      backupPath = backup(paths, agent, file);
      if (!prev && !hadOurs) {
        originalBackup = join(paths.backups, `${agent}-${basename(file)}.original`);
        copyFileSync(file, originalBackup);
      }
    }
    writeAtomic(file, serialize(next, text));
    state[agent] = {
      file,
      createdFile: prev ? prev.createdFile : !existed,
      record,
      ...(originalBackup ? { originalBackup } : {}),
      installedAt: Date.now(),
    };
    writeState(paths, state);
    return {
      agent,
      file,
      status: hadOurs ? 'updated' : 'installed',
      detail: `${events.length} eventos${backupPath ? `, backup em ${backupPath}` : ''}`,
      events,
      ...(backupPath ? { backup: backupPath } : {}),
    };
  } catch (err) {
    return { agent, file, status: 'error', detail: (err as Error).message, events };
  }
}

export interface DisconnectResult {
  agent: AgentId;
  file: string;
  status: 'removed' | 'restored' | 'deleted' | 'nothing' | 'error';
  detail: string;
  removed: number;
}

/** Remove somente os nossos hooks; restaura o arquivo original quando possível. */
export function disconnectTarget(paths: Paths, agent: AgentId, file: string): DisconnectResult {
  try {
    const state = readState(paths);
    const prev = state[agent]?.file === file ? state[agent] : undefined;
    const clearState = (): void => {
      if (state[agent]) {
        delete state[agent];
        writeState(paths, state);
      }
    };
    if (!existsSync(file)) {
      clearState();
      return { agent, file, status: 'nothing', detail: 'arquivo não existe', removed: 0 };
    }
    const text = readFileSync(file, 'utf8');
    const config = text.trim() === '' ? {} : parseConfig(text, file);
    const { config: next, removed } = removeHooks(config, HOOK_MARKER, prev?.record);
    if (removed === 0) {
      clearState();
      return { agent, file, status: 'nothing', detail: 'nenhum hook nosso encontrado', removed: 0 };
    }

    const backupPath = backup(paths, agent, file);
    if (prev?.createdFile && Object.keys(next).length === 0) {
      rmSync(realTarget(file), { force: true });
      clearState();
      return { agent, file, status: 'deleted', detail: 'arquivo criado por nós foi removido', removed };
    }

    let original: string | undefined;
    if (prev?.originalBackup && existsSync(prev.originalBackup)) {
      const candidate = readFileSync(prev.originalBackup, 'utf8');
      try {
        if (deepEqual(JSON.parse(candidate), next)) original = candidate;
      } catch {
        /* backup ilegível: cai para a serialização normal */
      }
    }
    if (original !== undefined) {
      writeAtomic(file, original);
      rmSync(prev!.originalBackup!, { force: true });
      clearState();
      return { agent, file, status: 'restored', detail: 'arquivo original restaurado byte a byte', removed };
    }
    writeAtomic(file, serialize(next, text));
    clearState();
    return { agent, file, status: 'removed', detail: `hooks removidos (backup em ${backupPath})`, removed };
  } catch (err) {
    return { agent, file, status: 'error', detail: (err as Error).message, removed: 0 };
  }
}

/** Quantos dos eventos esperados estão instalados no arquivo. */
export function installedCount(file: string, events: string[]): number {
  try {
    return countInstalled(JSON.parse(readFileSync(file, 'utf8')), events, HOOK_MARKER);
  } catch {
    return 0;
  }
}

// ───────────────────────── descoberta dos agentes ─────────────────────────

export interface AgentBinary {
  path: string;
  version: string | null;
}

function which(cmd: string): string | null {
  try {
    const tool = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(tool, [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
    return out.split(/\r?\n/).find(Boolean)?.trim() || null;
  } catch {
    return null;
  }
}

function versionOf(bin: string): string | null {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 });
    return out.split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}

export function findClaude(): AgentBinary | null {
  const path = which('claude');
  return path ? { path, version: versionOf(path) } : null;
}

/** O Codex pode vir do PATH ou embutido no app de desktop (fora do PATH). */
export function findCodex(paths: Paths): AgentBinary | null {
  const candidates: string[] = [];
  const fromPath = which('codex');
  if (fromPath) candidates.push(fromPath);
  try {
    const m = readFileSync(paths.codexConfig, 'utf8').match(/^\s*CODEX_CLI_PATH\s*=\s*"([^"]+)"/m);
    if (m?.[1]) candidates.push(m[1]);
  } catch {
    /* sem config.toml */
  }
  candidates.push(
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  );
  for (const c of candidates) {
    if (existsSync(c)) return { path: c, version: versionOf(c) };
  }
  return null;
}

/**
 * O Codex só executa hooks depois que o usuário os revisa e aprova ("/hooks"
 * na CLI ou "Review hooks" no app). O estado fica em `config.toml`, em
 * `hooks.state."file:<hooks.json>:<evento>:<i>:<j>"`. Leitura de melhor esforço.
 */
export function codexTrust(paths: Paths, events: string[]): { trusted: number; total: number } {
  const total = events.length;
  let text: string;
  try {
    text = readFileSync(paths.codexConfig, 'utf8');
  } catch {
    return { trusted: 0, total };
  }
  const file = realTarget(paths.codexHooks);
  const snake = (e: string): string => e.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  const wanted = new Set(events.map(snake));
  const trusted = new Set<string>();
  const sections = text.split(/^\[/m);
  for (const section of sections) {
    const header = section.slice(0, section.indexOf(']'));
    if (!header.startsWith('hooks.state.')) continue;
    if (!header.includes(file) && !header.includes(paths.codexHooks)) continue;
    const m = header.match(/:([a-z_]+):\d+:\d+["']?$/);
    if (!m || !wanted.has(m[1]!)) continue;
    if (/^\s*trusted_hash\s*=\s*"[^"]+"/m.test(section) && !/^\s*enabled\s*=\s*false/m.test(section)) {
      trusted.add(m[1]!);
    }
  }
  return { trusted: trusted.size, total };
}

// ───────────────────────── saúde do settings.json do Claude ─────────────────────────

export interface SettingsProblem {
  key: string;
  message: string;
  fixable: boolean;
}

/**
 * O Claude Code ignora o settings.json INTEIRO (hooks e permissões incluídos)
 * quando alguma chave falha na validação. Detectamos aqui os casos conhecidos.
 */
export function claudeSettingsProblems(config: unknown): SettingsProblem[] {
  const problems: SettingsProblem[] = [];
  if (isObject(config) && isObject(config.statusLine) && config.statusLine.type !== 'command') {
    problems.push({
      key: 'statusLine.type',
      message: 'statusLine sem "type": "command"',
      fixable: typeof config.statusLine.command === 'string',
    });
  }
  return problems;
}

export function readClaudeSettingsProblems(file: string): SettingsProblem[] {
  try {
    return claudeSettingsProblems(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return [];
  }
}

/** Corrige os problemas conhecidos do settings.json (com backup). */
export function fixClaudeSettings(paths: Paths): { status: 'fixed' | 'nothing' | 'error'; detail: string; backup?: string } {
  const file = paths.claudeSettings;
  try {
    if (!existsSync(file)) return { status: 'nothing', detail: 'settings.json não existe' };
    const text = readFileSync(file, 'utf8');
    const config = parseConfig(text, file);
    const fixable = claudeSettingsProblems(config).filter((p) => p.fixable);
    if (fixable.length === 0) return { status: 'nothing', detail: 'nenhum problema conhecido encontrado' };
    const next: JsonObject = { ...config };
    if (isObject(next.statusLine)) {
      // "type" primeiro, demais chaves na ordem original.
      const rest = Object.fromEntries(Object.entries(next.statusLine).filter(([k]) => k !== 'type'));
      next.statusLine = { type: 'command', ...rest };
    }
    const backupPath = backup(paths, 'claude', file);
    writeAtomic(file, serialize(next, text));
    return { status: 'fixed', detail: fixable.map((p) => p.key).join(', '), backup: backupPath };
  } catch (err) {
    return { status: 'error', detail: (err as Error).message };
  }
}
