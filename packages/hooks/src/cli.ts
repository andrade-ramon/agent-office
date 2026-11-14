#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { currentAlert, describeAlert, disableAlert, enableAlert, speakOnce } from './alert.js';
import { runDoctor, type Level } from './doctor.js';
import {
  CLAUDE_EVENTS,
  claudeHandlers,
  codexHandlers,
  codexTrust,
  connectTarget,
  disconnectTarget,
  fixClaudeSettings,
  findClaude,
  findCodex,
  installHookFiles,
  installedCount,
  parseVersion,
  readClaudeSettingsProblems,
  removeHookFiles,
  type ConnectResult,
  type DisconnectResult,
} from './install.js';
import { DEFAULT_PORT, getPaths, readConfig, resolvePort, writeConfig, type Paths } from './paths.js';
import {
  clearPidFile,
  getHealth,
  killPid,
  readPidFile,
  startDetached,
  waitForDown,
  waitForHealth,
} from './server-control.js';
import {
  buildSpec,
  installService,
  restartService,
  serviceStatus,
  startService,
  stopService,
  uninstallService,
} from './service.js';

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, s: string): string => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s: string): string => paint('32', s);
const yellow = (s: string): string => paint('33', s);
const red = (s: string): string => paint('31', s);
const dim = (s: string): string => paint('2', s);
const bold = (s: string): string => paint('1', s);

const MARK: Record<Level, string> = { ok: green('✓'), warn: yellow('⚠'), fail: red('✗') };

function line(level: Level, title: string, detail?: string): void {
  console.log(`  ${MARK[level]} ${bold(title)}${detail ? dim(` — ${detail}`) : ''}`);
}

const HELP = `${bold('agent-office')} — escritório 2D dos seus agentes de código

Uso: agent-office <comando> [opções]

  connect      instala os hooks no Claude Code e no Codex (mescla, com backup)
                 --claude | --codex   só um dos agentes
                 --port <n>           porta do servidor (padrão ${DEFAULT_PORT})
  disconnect   remove somente os hooks do agent-office   (--claude | --codex)
  status       mostra servidor, hooks e inicialização automática
  start        inicia o servidor em segundo plano
                 --foreground         roda neste terminal
                 --demo               modo demonstração (sessões simuladas)
                 --open               abre o navegador
  stop         para o servidor
  restart      reinicia o servidor
  open         abre a interface no navegador
  service      inicialização automática: install | uninstall | status | restart
  alert        alerta por voz: fala um texto (seu nome) e repete enquanto algum
               agente estiver esperando uma decisão sua (permissão ou pergunta)
                 on ["texto"] [--voice <voz>] [--every <seg>] [--delay <seg>]
                 off | test | status
  doctor       diagnóstico completo
  fix-settings corrige problemas conhecidos do ~/.claude/settings.json que fazem
               o Claude Code ignorar o arquivo (ex.: statusLine sem "type")
  uninstall    disconnect + remove o serviço   (--purge apaga ~/.agent-office)
`;

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}
function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args, () => undefined);
}

function which(args: string[]): { claude: boolean; codex: boolean } {
  const onlyClaude = flag(args, '--claude');
  const onlyCodex = flag(args, '--codex');
  if (!onlyClaude && !onlyCodex) return { claude: true, codex: true };
  return { claude: onlyClaude, codex: onlyCodex };
}

function reportConnect(r: ConnectResult): void {
  const name = r.agent === 'claude' ? 'Claude Code' : 'Codex';
  const level: Level = r.status === 'error' ? 'fail' : 'ok';
  const label = { installed: 'hooks instalados', updated: 'hooks atualizados', unchanged: 'já conectado', error: 'falhou' }[r.status];
  line(level, `${name}: ${label}`, `${r.file}${r.status === 'error' || r.status === 'unchanged' ? ` (${r.detail})` : ''}`);
  if (r.backup) console.log(dim(`      backup: ${r.backup}`));
}

function reportDisconnect(r: DisconnectResult): void {
  const name = r.agent === 'claude' ? 'Claude Code' : 'Codex';
  line(r.status === 'error' ? 'fail' : 'ok', `${name}: ${r.detail}`, r.file);
}

// ───────────────────────── comandos ─────────────────────────

async function cmdConnect(paths: Paths, args: string[]): Promise<number> {
  const target = which(args);
  const portArg = Number(option(args, '--port'));
  const config = readConfig(paths);
  if (portArg > 0) config.port = portArg;
  writeConfig(paths, config);
  installHookFiles(paths);

  console.log(bold('\nConectando agentes ao agent-office\n'));
  let failed = false;

  if (target.claude) {
    if (!existsSync(paths.claudeHome) && !findClaude()) {
      line('warn', 'Claude Code não encontrado', 'pulei');
    } else {
      const r = connectTarget(paths, 'claude', paths.claudeSettings, claudeHandlers(paths.hookLauncher));
      reportConnect(r);
      failed ||= r.status === 'error';
      const problems = readClaudeSettingsProblems(paths.claudeSettings);
      if (problems.length > 0) {
        console.log(
          yellow('      atenção: ') +
            `o Claude Code está ignorando este settings.json inteiro (${problems.map((p) => p.message).join('; ')}).\n` +
            '      Isso já acontecia antes do agent-office e vale para todos os seus hooks e permissões.\n' +
            '      Para corrigir (com backup): agent-office fix-settings\n' +
            dim('      Enquanto isso, o watcher de ~/.claude/projects mostra as sessões do Claude.'),
        );
      }
    }
  }

  if (target.codex) {
    const codex = findCodex(paths);
    if (!existsSync(paths.codexHome) && !codex) {
      line('warn', 'Codex não encontrado', 'pulei');
    } else {
      const handlers = codexHandlers(paths.hookLauncher, parseVersion(codex?.version));
      const r = connectTarget(paths, 'codex', paths.codexHooks, handlers);
      reportConnect(r);
      failed ||= r.status === 'error';
      if (r.status !== 'error') {
        const trust = codexTrust(paths, Object.keys(handlers));
        if (trust.trusted < trust.total) {
          console.log(
            yellow('      ação sua: ') +
              'o Codex só executa hooks depois que você os aprova uma vez.\n' +
              '      Abra o Codex e use "/hooks" (CLI) ou "Review hooks" (app de desktop).\n' +
              dim('      Enquanto isso, o watcher de ~/.codex/sessions já mostra as sessões do Codex.'),
          );
        }
      }
    }
  }

  const health = await getHealth(config.port);
  console.log('');
  if (health) line('ok', 'Servidor no ar', `http://localhost:${config.port}`);
  else line('warn', 'Servidor parado', 'rode "agent-office start" (os hooks não atrapalham os agentes enquanto isso)');
  console.log('');
  return failed ? 1 : 0;
}

function cmdDisconnect(paths: Paths, args: string[]): number {
  const target = which(args);
  console.log(bold('\nDesconectando agentes\n'));
  let failed = false;
  if (target.claude) {
    const r = disconnectTarget(paths, 'claude', paths.claudeSettings);
    reportDisconnect(r);
    failed ||= r.status === 'error';
  }
  if (target.codex) {
    const r = disconnectTarget(paths, 'codex', paths.codexHooks);
    reportDisconnect(r);
    failed ||= r.status === 'error';
  }
  const claudeLeft = installedCount(paths.claudeSettings, CLAUDE_EVENTS.map((e) => e.event));
  const codexLeft = installedCount(paths.codexHooks, Object.keys(codexHandlers(paths.hookLauncher, [9, 9, 9])));
  if (claudeLeft === 0 && codexLeft === 0) {
    removeHookFiles(paths);
    line('ok', 'Script de hook removido', paths.bin);
  }
  console.log('');
  return failed ? 1 : 0;
}

async function cmdStatus(paths: Paths): Promise<number> {
  const port = resolvePort(paths);
  const health = await getHealth(port);
  console.log(bold('\nagent-office — status\n'));
  if (health) {
    line(
      'ok',
      'Servidor',
      `http://localhost:${port} · v${health.version} · pid ${health.pid} · ${health.sessions} sessões · ${health.clients} abas abertas${health.demo ? ' · MODO DEMO' : ''}`,
    );
  } else {
    line('fail', 'Servidor', `parado (porta ${port})`);
  }

  const claudeEvents = CLAUDE_EVENTS.map((e) => e.event);
  const claudeN = installedCount(paths.claudeSettings, claudeEvents);
  line(claudeN === claudeEvents.length ? 'ok' : claudeN > 0 ? 'warn' : 'fail', 'Hooks do Claude Code', `${claudeN}/${claudeEvents.length} eventos`);
  const problems = readClaudeSettingsProblems(paths.claudeSettings);
  if (problems.length > 0) {
    line(
      'warn',
      'settings.json do Claude Code',
      `ignorado pelo Claude Code (${problems.map((p) => p.message).join('; ')}) — corrija com "agent-office fix-settings"`,
    );
  }

  const codex = findCodex(paths);
  const codexEvents = Object.keys(codexHandlers(paths.hookLauncher, parseVersion(codex?.version)));
  const codexN = installedCount(paths.codexHooks, codexEvents);
  const trust = codexTrust(paths, codexEvents);
  line(
    codexN !== codexEvents.length ? (codexN > 0 ? 'warn' : 'fail') : trust.trusted >= trust.total ? 'ok' : 'warn',
    'Hooks do Codex',
    `${codexN}/${codexEvents.length} eventos${codexN > 0 && trust.trusted < trust.total ? ' · aguardando sua aprovação no Codex (/hooks)' : ''}`,
  );

  const service = serviceStatus();
  line(
    service.running ? 'ok' : 'warn',
    'Inicialização automática',
    service.installed ? `${service.kind} ${service.running ? 'ativo' : 'parado'}` : 'não configurada',
  );
  const alert = currentAlert(paths);
  if (alert.enabled) line('ok', 'Alerta por voz', describeAlert(alert));
  if (health?.lastHookAt) {
    const fmt = (t: number | null): string => (t ? new Date(t).toLocaleTimeString() : 'nunca');
    console.log(dim(`\n  último hook recebido — Claude: ${fmt(health.lastHookAt.claude)} · Codex: ${fmt(health.lastHookAt.codex)}`));
  }
  console.log('');
  return health ? 0 : 1;
}

function runForeground(paths: Paths, serverArgs: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [paths.serverEntry, ...serverArgs], {
      stdio: 'inherit',
      env: { ...process.env, AGENT_OFFICE_HOME: paths.home },
    });
    const forward = (sig: NodeJS.Signals): void => {
      child.kill(sig);
    };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

async function cmdStart(paths: Paths, args: string[]): Promise<number> {
  if (!existsSync(paths.serverEntry)) {
    console.error(red('Servidor não compilado. Rode "npm run build" na raiz do repositório.'));
    return 1;
  }
  const open = flag(args, '--open');
  if (flag(args, '--demo')) {
    return runForeground(paths, ['--demo', ...(open ? ['--open'] : [])]);
  }
  const port = Number(option(args, '--port')) || resolvePort(paths);
  if (flag(args, '--foreground') || flag(args, '-f')) {
    return runForeground(paths, ['--port', String(port), ...(open ? ['--open'] : [])]);
  }

  const url = `http://localhost:${port}`;
  if (await getHealth(port)) {
    line('ok', 'Servidor já está no ar', url);
    if (open) openBrowser(url);
    return 0;
  }
  const service = serviceStatus();
  if (service.installed) {
    const r = startService();
    if (!r.ok) line('warn', 'Não consegui iniciar pelo serviço', r.detail);
  } else {
    startDetached(paths, port);
  }
  const health = await waitForHealth(port, 15_000);
  if (!health) {
    console.error(red(`O servidor não respondeu em ${url}. Veja o log em ${paths.logs}/server.log`));
    return 1;
  }
  line('ok', 'Servidor no ar', `${url}${service.installed ? ` (${service.kind})` : ` (pid ${health.pid})`}`);
  if (open) openBrowser(url);
  return 0;
}

async function cmdStop(paths: Paths): Promise<number> {
  const port = resolvePort(paths);
  const service = serviceStatus();
  const health = await getHealth(port);
  if (service.installed && service.running) {
    stopService();
    line('ok', 'Serviço parado', 'volta no próximo login; "agent-office service uninstall" desativa de vez');
  } else if (health) {
    killPid(health.pid);
  } else {
    const pid = readPidFile(paths);
    if (pid) killPid(pid);
  }
  clearPidFile(paths);
  const down = await waitForDown(port);
  line(down ? 'ok' : 'fail', down ? 'Servidor parado' : 'O servidor ainda responde', `porta ${port}`);
  return down ? 0 : 1;
}

async function cmdService(paths: Paths, args: string[]): Promise<number> {
  const sub = args[0] ?? 'status';
  const port = resolvePort(paths);
  if (sub === 'install') {
    if (!existsSync(paths.serverEntry)) {
      console.error(red('Servidor não compilado. Rode "npm run build" antes.'));
      return 1;
    }
    // Um servidor avulso ocuparia a porta do serviço.
    const running = await getHealth(port);
    const before = serviceStatus();
    if (running && !(before.running && before.pid === running.pid)) {
      killPid(running.pid);
      await waitForDown(port);
      clearPidFile(paths);
    }
    const r = installService(buildSpec(paths, port));
    if (!r.ok) {
      line('fail', 'Inicialização automática', r.detail);
      return 1;
    }
    const health = await waitForHealth(port, 20_000);
    line(health ? 'ok' : 'fail', 'Inicialização automática configurada', r.detail);
    if (health) line('ok', 'Servidor no ar', `http://localhost:${port} (pid ${health.pid})`);
    return health ? 0 : 1;
  }
  if (sub === 'uninstall') {
    const r = uninstallService();
    line(r.ok ? 'ok' : 'fail', 'Inicialização automática', r.detail);
    return r.ok ? 0 : 1;
  }
  if (sub === 'restart') {
    const before = (await getHealth(port))?.pid;
    const r = restartService();
    if (!r.ok) {
      line('fail', 'Reinício do serviço', r.detail);
      return 1;
    }
    await new Promise((res) => setTimeout(res, 800));
    const health = await waitForHealth(port, 20_000);
    const restarted = Boolean(health && health.pid !== before);
    line(restarted ? 'ok' : 'fail', 'Serviço reiniciado', health ? `pid ${before ?? '?'} → ${health.pid}` : 'servidor não voltou');
    return restarted ? 0 : 1;
  }
  const s = serviceStatus();
  line(
    s.running ? 'ok' : 'warn',
    'Inicialização automática',
    s.installed ? `${s.kind} ${s.running ? `ativo${s.pid ? ` (pid ${s.pid})` : ''}` : 'parado'} · ${s.file ?? ''}` : 'não configurada',
  );
  return 0;
}

async function cmdAlert(paths: Paths, args: string[]): Promise<number> {
  const sub = args[0] ?? 'status';
  const port = resolvePort(paths);
  if (sub === 'on') {
    const text = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
    const every = Number(option(args, '--every'));
    const delay = option(args, '--delay');
    const voice = option(args, '--voice');
    const r = enableAlert(paths, {
      ...(text ? { text } : {}),
      ...(voice ? { voice } : {}),
      ...(every > 0 ? { everySec: every } : {}),
      ...(delay !== undefined && Number(delay) >= 0 ? { delaySec: Number(delay) } : {}),
    });
    line(r.ok ? 'ok' : 'fail', r.ok ? 'Alerta por voz ligado' : 'Alerta por voz', r.detail);
    if (r.ok && !(await getHealth(port))) {
      console.log(dim('      O servidor está parado; o alerta vale quando ele subir (agent-office start).'));
    }
    return r.ok ? 0 : 1;
  }
  if (sub === 'off') {
    disableAlert(paths);
    line('ok', 'Alerta por voz desligado');
    return 0;
  }
  const alert = currentAlert(paths);
  if (sub === 'test') {
    if (!alert.text) {
      line('fail', 'Alerta por voz', 'nada configurado: agent-office alert on "Seu nome"');
      return 1;
    }
    const spoke = speakOnce(alert.text, alert.voice);
    line(spoke ? 'ok' : 'fail', spoke ? `Falei "${alert.text}"` : 'Não consegui falar', spoke ? 'se não ouviu, confira o volume' : 'sintetizador de voz indisponível');
    return spoke ? 0 : 1;
  }
  const health = await getHealth(port);
  line(alert.enabled ? 'ok' : 'warn', 'Alerta por voz', describeAlert(alert));
  if (health?.voiceAlert) {
    console.log(dim(`      servidor: ${health.voiceAlert.enabled ? 'ativo' : 'inativo'} · decisões pendentes agora: ${health.voiceAlert.pending}`));
  }
  return 0;
}

async function cmdDoctor(paths: Paths): Promise<number> {
  console.log(bold('\nagent-office doctor\n'));
  const checks = await runDoctor(paths);
  for (const c of checks) {
    line(c.level, c.title, c.detail);
    if (c.hint) console.log(`      ${c.level === 'fail' ? red('→') : yellow('→')} ${c.hint}`);
  }
  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  console.log('');
  if (fails === 0 && warns === 0) console.log(green(bold('  Tudo verde. ✔')));
  else if (fails === 0) console.log(`${green(bold('  Funcionando'))} — ${yellow(`${warns} ponto(s) de atenção`)} acima.`);
  else console.log(red(bold(`  ${fails} problema(s) encontrado(s).`)));
  console.log('');
  return fails === 0 ? 0 : 1;
}

async function cmdUninstall(paths: Paths, args: string[]): Promise<number> {
  cmdDisconnect(paths, []);
  await cmdStop(paths);
  const r = uninstallService();
  line(r.ok ? 'ok' : 'warn', 'Inicialização automática', r.detail);
  if (flag(args, '--purge')) {
    rmSync(paths.home, { recursive: true, force: true });
    line('ok', 'Dados removidos', paths.home);
  } else {
    console.log(dim(`\n  Histórico e backups preservados em ${paths.home} (use --purge para apagar).`));
  }
  console.log('');
  return 0;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  const paths = getPaths();
  switch (command) {
    case 'connect':
      return cmdConnect(paths, args);
    case 'disconnect':
      return cmdDisconnect(paths, args);
    case 'status':
      return cmdStatus(paths);
    case 'start':
      return cmdStart(paths, args);
    case 'stop':
      return cmdStop(paths);
    case 'restart': {
      const service = serviceStatus();
      if (service.installed && service.running) return cmdService(paths, ['restart']);
      await cmdStop(paths);
      return cmdStart(paths, args);
    }
    case 'open': {
      const url = `http://localhost:${resolvePort(paths)}`;
      openBrowser(url);
      console.log(url);
      return 0;
    }
    case 'service':
      return cmdService(paths, args);
    case 'alert':
      return cmdAlert(paths, args);
    case 'doctor':
      return cmdDoctor(paths);
    case 'fix-settings': {
      const r = fixClaudeSettings(paths);
      line(r.status === 'error' ? 'fail' : 'ok', r.status === 'fixed' ? 'settings.json corrigido' : 'settings.json', r.detail);
      if (r.backup) console.log(dim(`      backup: ${r.backup}`));
      if (r.status === 'fixed') {
        console.log(dim('      O arquivo volta a valer para sessões novas do Claude Code (hooks, permissões e demais ajustes).'));
      }
      return r.status === 'error' ? 1 : 0;
    }
    case 'uninstall':
      return cmdUninstall(paths, args);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;
    default:
      console.error(red(`Comando desconhecido: ${command}\n`));
      console.log(HELP);
      return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(red(`Erro: ${(err as Error).message}`));
    process.exitCode = 1;
  },
);
