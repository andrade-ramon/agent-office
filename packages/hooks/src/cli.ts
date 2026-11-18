#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { addPeer, checkSshPeer, describePeer, listPeers, removePeer } from './peers.js';
import { currentRate, formatRate, resetRate, setRate } from './rate.js';
import { CLOUD_AGENTS, cloudLabel, currentCloud, describeCloud, disableCloud, enableCloud, type CloudAgent } from './cloud.js';
import { currentAlert, describeAlert, disableAlert, enableAlert, isAlertSound, playOnce, speakOnce } from './alert.js';
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
  getServerRate,
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
  alert        alerta sonoro: toca uma sirene (ou fala seu nome) e repete enquanto
               algum agente estiver esperando uma decisão sua (permissão ou pergunta)
                 on ["texto"] [--sound siren|beep|voice] [--voice <voz>]
                    [--every <seg>] [--delay <seg>]
                 off | test | status
  cloud        mostra também as sessões que rodam na nuvem do Codex e do Claude
               (consulta a sua conta pela CLI de cada agente; desligado por padrão)
                 on [--codex] [--claude] [--every <seg>] | off [--codex] [--claude] | status
  peer         mostra também as sessões de outro computador seu que roda o
               agent-office (por túnel SSH; nada passa por terceiros)
                 add <nome> <host|usuario@host> [--port <porta de lá>]
                 add <nome> --url http://127.0.0.1:<porta>   (túnel que você mantém)
                 remove <nome> | status
  rate         câmbio do custo em reais no painel de dados (o agent-office não
               consulta cotação: sem um valor seu, vale a referência embutida)
                 <reais por dólar> | reset | status
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
  if (alert.enabled) line('ok', 'Alerta sonoro', describeAlert(alert));
  for (const agent of CLOUD_AGENTS) {
    const cloud = currentCloud(paths, agent);
    if (!cloud.enabled) continue;
    const c = agent === 'codex' ? health?.codexCloud : health?.claudeCloud;
    line(c?.error ? 'warn' : 'ok', cloudLabel(agent), c?.error ? `consulta falhando: ${c.error}` : describeCloud(cloud, agent));
  }
  for (const peer of listPeers(paths)) {
    const p = health?.peers?.find((x) => x.name === peer.name);
    const detail = p?.connected ? `conectada · ${p.sessions} ${p.sessions === 1 ? 'sessão' : 'sessões'}` : `sem conexão${p?.error ? `: ${p.error}` : ''}`;
    line(p?.connected ? 'ok' : 'warn', `Máquina "${peer.name}"`, detail);
  }
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

async function cmdCloud(paths: Paths, args: string[]): Promise<number> {
  const sub = args[0] ?? 'status';
  const port = resolvePort(paths);
  // Sem --codex/--claude, vale para os dois.
  const picked = CLOUD_AGENTS.filter((a) => args.includes(`--${a}`));
  const agents: readonly CloudAgent[] = picked.length > 0 ? picked : CLOUD_AGENTS;
  if (sub === 'on') {
    const every = Number(option(args, '--every'));
    let any = false;
    for (const agent of agents) {
      const r = enableCloud(paths, agent, every > 0 ? { everySec: every } : {});
      line(r.ok ? 'ok' : 'fail', r.ok ? `${cloudLabel(agent)} ligado` : cloudLabel(agent), r.detail);
      any = any || r.ok;
    }
    if (any && !(await getHealth(port))) {
      console.log(dim('      O servidor está parado; a consulta começa quando ele subir (agent-office start).'));
    }
    return any ? 0 : 1;
  }
  if (sub === 'off') {
    for (const agent of agents) {
      disableCloud(paths, agent);
      line('ok', `${cloudLabel(agent)} desligado`, 'as sessões da nuvem saem do escritório');
    }
    return 0;
  }
  const health = await getHealth(port);
  for (const agent of CLOUD_AGENTS) {
    const cloud = currentCloud(paths, agent);
    line(cloud.enabled ? 'ok' : 'warn', cloudLabel(agent), describeCloud(cloud, agent));
    const c = agent === 'codex' ? health?.codexCloud : health?.claudeCloud;
    if (!cloud.enabled || !c) continue;
    const last = c.lastOkAt ? new Date(c.lastOkAt).toLocaleTimeString() : 'nunca';
    console.log(dim(`      servidor: ${c.enabled ? 'ativo' : 'inativo'} · rodando agora: ${c.running} · última consulta: ${last}`));
    if (c.error) console.log(dim(`      erro: ${c.error}`));
  }
  return 0;
}

async function cmdPeer(paths: Paths, args: string[]): Promise<number> {
  const sub = args[0] ?? 'status';
  const port = resolvePort(paths);
  if (sub === 'add') {
    const positional = args.slice(1).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'));
    const [name, ssh] = positional;
    const url = option(args, '--url');
    const remotePort = Number(option(args, '--port'));
    if (!name) {
      line('fail', 'Máquina', 'uso: agent-office peer add <nome> <host|usuario@host> [--port <porta>]');
      return 1;
    }
    const r = addPeer(paths, { name, ...(ssh ? { ssh } : {}), ...(url ? { url } : {}), ...(remotePort > 0 ? { remotePort } : {}) });
    line(r.ok ? 'ok' : 'fail', r.ok ? `Máquina "${name}" cadastrada` : 'Máquina', r.detail);
    if (!r.ok || !r.peer) return 1;
    if (r.peer.ssh) {
      const check = checkSshPeer(r.peer.ssh, r.peer.remotePort ?? port);
      line(check.ok ? 'ok' : 'warn', 'Teste de acesso', check.detail);
      if (!check.ok) console.log(dim('      O cadastro foi mantido: o servidor tenta de novo sozinho quando o acesso estiver pronto.'));
    }
    if (!(await getHealth(port))) console.log(dim('      O servidor está parado; a conexão começa quando ele subir (agent-office start).'));
    return 0;
  }
  if (sub === 'remove' || sub === 'rm') {
    const name = args[1] ?? '';
    const removed = removePeer(paths, name);
    line(removed ? 'ok' : 'fail', removed ? `Máquina "${name}" removida` : 'Máquina', removed ? 'as sessões dela saem do escritório' : `não há máquina chamada "${name}"`);
    return removed ? 0 : 1;
  }
  const peers = listPeers(paths);
  if (peers.length === 0) {
    line('warn', 'Outras máquinas', 'nenhuma cadastrada: agent-office peer add <nome> <host|usuario@host>');
    return 0;
  }
  const health = await getHealth(port);
  for (const peer of peers) {
    const p = health?.peers?.find((x) => x.name === peer.name);
    line(p?.connected ? 'ok' : 'warn', `Máquina "${peer.name}"`, describePeer(peer));
    if (!p) continue;
    const last = p.lastOkAt ? new Date(p.lastOkAt).toLocaleTimeString() : 'nunca';
    console.log(dim(`      ${p.connected ? 'conectada' : 'sem conexão'} · sessões: ${p.sessions} · último contato: ${last}`));
    if (p.error) console.log(dim(`      erro: ${p.error}`));
  }
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
    const sound = option(args, '--sound');
    if (sound !== undefined && !isAlertSound(sound)) {
      line('fail', 'Alerta sonoro', `som desconhecido "${sound}": use siren, beep ou voice`);
      return 1;
    }
    const r = enableAlert(paths, {
      ...(sound ? { sound } : {}),
      ...(text ? { text } : {}),
      ...(voice ? { voice } : {}),
      ...(every > 0 ? { everySec: every } : {}),
      ...(delay !== undefined && Number(delay) >= 0 ? { delaySec: Number(delay) } : {}),
    });
    line(r.ok ? 'ok' : 'fail', r.ok ? 'Alerta sonoro ligado' : 'Alerta sonoro', r.detail);
    if (r.ok && !(await getHealth(port))) {
      console.log(dim('      O servidor está parado; o alerta vale quando ele subir (agent-office start).'));
    }
    return r.ok ? 0 : 1;
  }
  if (sub === 'off') {
    disableAlert(paths);
    line('ok', 'Alerta sonoro desligado');
    return 0;
  }
  const alert = currentAlert(paths);
  if (sub === 'test') {
    if (alert.sound && alert.sound !== 'voice') {
      const played = playOnce(paths, alert.sound);
      line(played ? 'ok' : 'fail', played ? `Toquei ${alert.sound === 'siren' ? 'a sirene' : 'o bipe'}` : 'Não consegui tocar', played ? 'se não ouviu, confira o volume' : 'tocador de áudio indisponível');
      return played ? 0 : 1;
    }
    if (!alert.text) {
      line('fail', 'Alerta sonoro', 'nada configurado: agent-office alert on --sound siren');
      return 1;
    }
    const spoke = speakOnce(alert.text, alert.voice);
    line(spoke ? 'ok' : 'fail', spoke ? `Falei "${alert.text}"` : 'Não consegui falar', spoke ? 'se não ouviu, confira o volume' : 'sintetizador de voz indisponível');
    return spoke ? 0 : 1;
  }
  const health = await getHealth(port);
  line(alert.enabled ? 'ok' : 'warn', 'Alerta sonoro', describeAlert(alert));
  if (health?.voiceAlert) {
    console.log(dim(`      servidor: ${health.voiceAlert.enabled ? 'ativo' : 'inativo'} · decisões pendentes agora: ${health.voiceAlert.pending}`));
  }
  return 0;
}

async function cmdRate(paths: Paths, args: string[]): Promise<number> {
  const sub = args[0] ?? 'status';
  if (sub === 'reset' || sub === 'off') {
    const had = resetRate(paths);
    line('ok', 'Câmbio', had ? 'voltou para a referência embutida' : 'já estava na referência embutida');
    return 0;
  }
  if (sub !== 'status') {
    const r = setRate(paths, sub);
    line(r.ok ? 'ok' : 'fail', r.ok ? 'Câmbio definido' : 'Câmbio', r.ok ? `${r.detail} — o painel de dados já usa o novo valor` : r.detail);
    return r.ok ? 0 : 1;
  }
  const mine = currentRate(paths);
  if (mine !== undefined) {
    line('ok', 'Câmbio', `${formatRate(mine)} (definido por você)`);
    return 0;
  }
  const server = await getServerRate(resolvePort(paths));
  if (server) {
    const [y, m, d] = (server.asOf ?? '').split('-');
    line('ok', 'Câmbio', `${formatRate(server.rate)} (referência embutida${d ? ` de ${d}/${m}/${y}` : ''})`);
  } else {
    line('warn', 'Câmbio', 'referência embutida (o servidor está parado; inicie-o para ver o valor)');
  }
  console.log(dim('      Para usar a cotação de hoje, informe quantos reais vale um dólar: agent-office rate 5,43'));
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
    case 'cloud':
      return cmdCloud(paths, args);
    case 'peer':
    case 'peers':
      return cmdPeer(paths, args);
    case 'rate':
    case 'cambio':
    case 'câmbio':
      return cmdRate(paths, args);
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
