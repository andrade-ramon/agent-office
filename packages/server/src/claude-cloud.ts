import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RemoteSessionWatcher,
  type RemoteSession,
  type RemoteSettings,
  type RemoteState,
} from './remote-sessions.js';
import type { SessionStore } from './state.js';
import { hashString, isObj, str } from './util.js';

export type ClaudeCloudSettings = RemoteSettings;

export const CLAUDE_CLOUD_ENTRYPOINT = 'Claude Cloud';
/** A listagem não traz o endereço de cada sessão: o duplo clique abre a página geral. */
export const CLAUDE_CLOUD_URL = 'https://claude.ai/code';

/**
 * A CLI do Claude não tem um comando documentado para listar as sessões em
 * nuvem. O comando interno `/list-agents` lista — sem chamar o modelo, sem
 * gastar tokens — desde que o recurso experimental de sessões entre máquinas
 * esteja ligado; estas variáveis de ambiente o ligam para esta chamada.
 * É um caminho não documentado: pode mudar ou sumir numa atualização da CLI.
 */
export const CLAUDE_CLOUD_ENV = { CLAUDE_CODE_HARBOR_KITE: '1', CLAUDE_CODE_HARBOR_KITE_CLOUD: '1' } as const;

/** Chamada enxuta: sem servidores MCP, sem transcript em disco e sem os hooks do usuário. */
export const CLAUDE_CLOUD_ARGS = [
  '-p',
  '/list-agents',
  '--output-format',
  'json',
  '--strict-mcp-config',
  '--no-session-persistence',
  '--setting-sources',
  '',
] as const;

/**
 * A consulta sobe um processo da CLI por alguns segundos. Ele roda nesta pasta
 * para que o observador de processos do Claude o reconheça e não o mostre como
 * uma sessão de verdade.
 */
export const CLAUDE_PROBE_DIR = 'agent-office-cloud-probe';

function probeDir(): string {
  const dir = join(tmpdir(), CLAUDE_PROBE_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const STATE: Record<string, RemoteState> = {
  running: 'running',
  idle: 'done',
  'waiting on a human': 'waiting',
};

/** `  [estado]  ·  título  ·  cloud` — a linha de uma sessão em nuvem na listagem. */
const CLOUD_ROW = /^\s*\[([^\]]+)\]\s+·\s+(.*?)\s+·\s+cloud\s*$/;

/** Roda a listagem e devolve a saída bruta (injetável nos testes). */
export type ListClaudeCloud = (bin: string) => Promise<string>;

/** Extrai o texto de `claude -p ... --output-format json` (a saída pode vir com linhas de aviso). */
export function claudeResultText(output: string): string {
  for (const line of output.split('\n')) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isObj(parsed) || parsed.type !== 'result') continue;
    const result = str(parsed.result);
    if (parsed.is_error === true || result === undefined) throw new Error('a CLI do Claude devolveu um erro');
    return result;
  }
  throw new Error('saída inesperada da CLI do Claude');
}

/**
 * Lê a listagem `/list-agents` e fica só com as sessões em nuvem. A listagem
 * traz título e estado — não há id: a sessão é identificada pelo título (uma
 * sessão renomeada entra de novo; títulos repetidos ganham um sufixo).
 */
export function parseClaudeCloudList(text: string): RemoteSession[] {
  if (/cloud session list could not be fetched/i.test(text)) {
    throw new Error('a lista de sessões em nuvem não pôde ser consultada agora');
  }
  const sessions: RemoteSession[] = [];
  const seen = new Map<string, number>();
  for (const line of text.split('\n')) {
    const m = CLOUD_ROW.exec(line);
    if (!m) continue;
    const state = STATE[m[1]!.trim().toLowerCase()];
    if (!state) continue; // estado desconhecido: não inventamos um
    const raw = m[2]!.trim();
    const title = raw && raw !== '(untitled)' ? raw : undefined;
    const base = hashString(title ?? '').toString(36);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    sessions.push({
      id: n === 1 ? base : `${base}-${n}`,
      state,
      url: CLAUDE_CLOUD_URL,
      ...(title ? { title } : {}),
    });
  }
  return sessions;
}

export const runClaudeCloudList: ListClaudeCloud = (bin) =>
  new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...CLAUDE_CLOUD_ENV };
    delete env.CLAUDECODE;
    const child = execFile(
      bin,
      [...CLAUDE_CLOUD_ARGS],
      { timeout: 45_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env, cwd: probeDir() },
      (err, stdout, stderr) => {
        if (err && !String(stdout).trim()) reject(new Error((String(stderr).trim().split('\n').pop() || err.message).slice(0, 200)));
        else resolve(String(stdout));
      },
    );
    // Sem isso a CLI espera alguns segundos por dados na entrada padrão.
    child.stdin?.end();
  });

/** Sessões do Claude Code em nuvem (claude.ai/code), consultadas pela CLI do Claude. */
export class ClaudeCloudWatcher extends RemoteSessionWatcher {
  constructor(
    store: SessionStore,
    settings: () => ClaudeCloudSettings,
    list: ListClaudeCloud = runClaudeCloudList,
    now: () => number = Date.now,
    log: (msg: string) => void = () => undefined,
  ) {
    super(
      store,
      settings,
      {
        agent: 'claude',
        entrypoint: CLAUDE_CLOUD_ENTRYPOINT,
        minEverySec: 30,
        list: async (bin) => parseClaudeCloudList(claudeResultText(await list(bin))),
      },
      now,
      log,
    );
  }
}
