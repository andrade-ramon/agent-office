import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_EVENTS,
  codexHandlers,
  codexTrust,
  findClaude,
  findCodex,
  installedCount,
  parseVersion,
} from './install.js';
import { HOST, resolvePort, type Paths } from './paths.js';
import { canConnect, getHealth, httpGet } from './server-control.js';
import { serviceStatus } from './service.js';

export type Level = 'ok' | 'warn' | 'fail';

export interface Check {
  level: Level;
  title: string;
  detail?: string;
  hint?: string;
}

const ok = (title: string, detail?: string): Check => ({ level: 'ok', title, ...(detail ? { detail } : {}) });
const warn = (title: string, detail?: string, hint?: string): Check => ({
  level: 'warn',
  title,
  ...(detail ? { detail } : {}),
  ...(hint ? { hint } : {}),
});
const fail = (title: string, detail?: string, hint?: string): Check => ({
  level: 'fail',
  title,
  ...(detail ? { detail } : {}),
  ...(hint ? { hint } : {}),
});

export interface HookRun {
  code: number | null;
  ms: number;
  stdout: string;
  stderr: string;
}

/** Executa o lançador do hook como o agente faria (payload em stdin). */
export function runHook(
  paths: Paths,
  agent: 'claude' | 'codex',
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv = {},
): HookRun {
  const t0 = process.hrtime.bigint();
  const win = process.platform === 'win32';
  const r = spawnSync(win ? 'cmd' : paths.hookLauncher, win ? ['/c', paths.hookLauncher, agent] : [agent], {
    input: JSON.stringify(payload),
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 8000,
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { code: r.status, ms, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function wsHello(port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WS) return resolve(false);
    let settled = false;
    const finish = (v: boolean, ws?: WebSocket): void => {
      if (settled) return;
      settled = true;
      try {
        ws?.close();
      } catch {
        /* ignora */
      }
      resolve(v);
    };
    try {
      const ws = new WS(`ws://${HOST}:${port}/ws`);
      const timer = setTimeout(() => finish(false, ws), timeoutMs);
      ws.onmessage = (ev) => {
        clearTimeout(timer);
        try {
          finish((JSON.parse(String(ev.data)) as { type?: string }).type === 'hello', ws);
        } catch {
          finish(false, ws);
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        finish(false, ws);
      };
    } catch {
      finish(false);
    }
  });
}

export async function runDoctor(paths: Paths): Promise<Check[]> {
  const checks: Check[] = [];
  const port = resolvePort(paths);

  // ── ambiente ──
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  checks.push(
    major > 22 || (major === 22 && minor >= 13)
      ? ok('Node.js', `v${process.versions.node}`)
      : fail('Node.js', `v${process.versions.node}`, 'requer Node 22.13 ou mais novo'),
  );
  checks.push(
    existsSync(paths.serverEntry) && existsSync(join(paths.webDist, 'index.html'))
      ? ok('Build', 'servidor e front-end compilados')
      : fail('Build', 'artefatos ausentes', 'rode "npm run build" na raiz do repositório'),
  );

  // ── servidor ──
  const health = await getHealth(port);
  if (!health) {
    checks.push(fail('Servidor', `sem resposta em http://${HOST}:${port}`, 'rode "agent-office start"'));
  } else {
    checks.push(
      ok('Servidor', `http://localhost:${port} · v${health.version} · no ar há ${Math.round(health.uptimeMs / 1000)}s`),
    );
    const external = Object.values(networkInterfaces())
      .flat()
      .filter((i): i is NonNullable<typeof i> => Boolean(i) && !i!.internal && i!.family === 'IPv4')
      .map((i) => i.address);
    let exposed: string | null = null;
    for (const addr of external) {
      if (await canConnect(addr, port)) {
        exposed = addr;
        break;
      }
    }
    checks.push(
      exposed
        ? fail('Somente local', `a porta ${port} responde em ${exposed}`, 'o servidor deveria escutar apenas em 127.0.0.1')
        : ok('Somente local', `escutando apenas em ${health.host} (inacessível pela rede)`),
    );

    const page = await httpGet(port, '/');
    checks.push(
      page?.status === 200 && health.webBuilt
        ? ok('Interface web', `http://localhost:${port}`)
        : fail('Interface web', 'front-end não está sendo servido', 'rode "npm run build" e reinicie o servidor'),
    );
    checks.push(
      (await wsHello(port))
        ? ok('WebSocket', `ws://localhost:${port}/ws`)
        : fail('WebSocket', 'sem resposta em /ws'),
    );
    const stats = await httpGet(port, '/api/stats');
    checks.push(
      stats?.status === 200 && (health.demo || existsSync(paths.db))
        ? ok('Histórico (SQLite)', health.demo ? 'em memória (modo demo)' : paths.db)
        : fail('Histórico (SQLite)', 'estatísticas indisponíveis'),
    );
    if (health.demo) {
      checks.push(warn('Watchers de arquivo', 'desativados no modo demo'));
    } else {
      checks.push(
        health.watcher.enabled
          ? ok(
              'Watchers de arquivo',
              `Claude: ${health.watcher.claudeFiles} transcripts · Codex: ${health.watcher.codexFiles} rollouts`,
            )
          : fail('Watchers de arquivo', 'desativados'),
      );
    }
  }

  // ── script de hook ──
  let hookReady = false;
  try {
    accessSync(paths.hookLauncher, constants.X_OK);
    const same = readFileSync(paths.hookScript, 'utf8') === readFileSync(paths.hookSource, 'utf8');
    hookReady = true;
    checks.push(
      same
        ? ok('Script de hook', paths.hookLauncher)
        : warn('Script de hook', 'versão instalada difere do repositório', 'rode "agent-office connect" para atualizar'),
    );
  } catch {
    checks.push(fail('Script de hook', 'não instalado', 'rode "agent-office connect"'));
  }

  if (hookReady) {
    // Fail-open: com o servidor "fora do ar" (porta fechada), o hook tem que sair 0, rápido e calado.
    const sample = { hook_event_name: 'PreToolUse', session_id: 'agent-office-doctor-failopen', cwd: '/', tool_name: 'Bash' };
    const down = runHook(paths, 'claude', sample, { AGENT_OFFICE_PORT: '9' });
    const silent = down.stdout.trim() === '' && down.stderr.trim() === '';
    checks.push(
      down.code === 0 && down.ms < 1500 && silent
        ? ok('Hook fail-open', `servidor fora do ar → exit 0 em ${Math.round(down.ms)} ms, sem saída`)
        : fail('Hook fail-open', `exit ${down.code} em ${Math.round(down.ms)} ms${silent ? '' : ', com saída'}`),
    );

    if (health) {
      const before = health.events.hook;
      const run = runHook(
        paths,
        'claude',
        { hook_event_name: 'SessionStart', session_id: `agent-office-doctor-${Date.now()}`, cwd: '/', source: 'startup' },
        { AGENT_OFFICE_PORT: String(port) },
      );
      const after = (await getHealth(port))?.events.hook ?? before;
      checks.push(
        run.code === 0 && after > before
          ? ok('Hook → servidor', `evento entregue em ${Math.round(run.ms)} ms`)
          : fail('Hook → servidor', 'o evento de teste não chegou ao servidor'),
      );
    }
  }

  // ── Claude Code ──
  const claude = findClaude();
  const claudeEvents = CLAUDE_EVENTS.map((e) => e.event);
  const claudeInstalled = installedCount(paths.claudeSettings, claudeEvents);
  if (!claude && !existsSync(paths.claudeHome)) {
    checks.push(warn('Claude Code', 'não encontrado nesta máquina'));
  } else {
    checks.push(
      claude ? ok('Claude Code', `${claude.version ?? 'versão desconhecida'} · ${claude.path}`) : warn('Claude Code', '`claude` não está no PATH'),
    );
    checks.push(
      claudeInstalled === claudeEvents.length
        ? ok('Hooks do Claude Code', `${claudeInstalled}/${claudeEvents.length} eventos em ${paths.claudeSettings}`)
        : fail('Hooks do Claude Code', `${claudeInstalled}/${claudeEvents.length} eventos instalados`, 'rode "agent-office connect"'),
    );
    checks.push(
      existsSync(join(paths.claudeHome, 'projects'))
        ? ok('Transcripts do Claude', join(paths.claudeHome, 'projects'))
        : warn('Transcripts do Claude', 'diretório ainda não existe (nenhuma sessão registrada)'),
    );
  }

  // ── Codex ──
  const codex = findCodex(paths);
  if (!codex && !existsSync(paths.codexHome)) {
    checks.push(warn('Codex', 'não encontrado nesta máquina'));
  } else {
    checks.push(
      codex ? ok('Codex', `${codex.version ?? 'versão desconhecida'} · ${codex.path}`) : warn('Codex', 'binário não localizado'),
    );
    const codexEvents = Object.keys(codexHandlers(paths.hookLauncher, parseVersion(codex?.version)));
    const codexInstalled = installedCount(paths.codexHooks, codexEvents);
    if (codexInstalled !== codexEvents.length) {
      checks.push(
        fail('Hooks do Codex', `${codexInstalled}/${codexEvents.length} eventos instalados`, 'rode "agent-office connect"'),
      );
    } else {
      const trust = codexTrust(paths, codexEvents);
      const seen = health?.lastHookAt.codex;
      if (trust.trusted >= trust.total) {
        checks.push(ok('Hooks do Codex', `${codexInstalled}/${codexEvents.length} eventos, aprovados no Codex`));
      } else {
        checks.push(
          warn(
            'Hooks do Codex',
            `${codexInstalled}/${codexEvents.length} eventos instalados; ${trust.trusted}/${trust.total} aprovados${seen ? ' (já recebemos eventos de hook)' : ''}`,
            'o Codex só executa hooks aprovados por você: abra o Codex e use "/hooks" (CLI) ou "Review hooks" (app). Enquanto isso o watcher de sessões cobre o Codex.',
          ),
        );
      }
    }
    const sessions = join(paths.codexHome, 'sessions');
    checks.push(
      existsSync(sessions)
        ? ok('Sessões do Codex (watcher)', sessions)
        : warn('Sessões do Codex (watcher)', 'diretório ainda não existe'),
    );
  }

  // ── inicialização automática ──
  const service = serviceStatus();
  if (!service.supported) {
    checks.push(warn('Inicialização automática', 'não suportada neste sistema'));
  } else if (!service.installed) {
    checks.push(warn('Inicialização automática', 'não configurada', 'rode "agent-office service install"'));
  } else if (!service.running) {
    checks.push(fail('Inicialização automática', `${service.kind} instalado, mas parado (${service.detail ?? '?'})`, 'rode "agent-office start"'));
  } else {
    const same = health && service.pid ? health.pid === service.pid : true;
    checks.push(
      same
        ? ok('Inicialização automática', `${service.kind} ativo${service.pid ? ` (pid ${service.pid})` : ''}`)
        : warn('Inicialização automática', `${service.kind} ativo, mas o servidor na porta ${port} é outro processo`),
    );
  }

  // ── dados ──
  try {
    const size = statSync(paths.home).isDirectory();
    if (size) checks.push(ok('Dados locais', paths.home));
  } catch {
    checks.push(warn('Dados locais', `${paths.home} ainda não existe`));
  }

  return checks;
}
