import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import type { Paths } from './paths.js';

export const SERVICE_LABEL = 'com.agent-office.server';
const SYSTEMD_UNIT = 'agent-office.service';
const WINDOWS_TASK = 'agent-office';

export interface ServiceSpec {
  node: string;
  serverEntry: string;
  port: number;
  logFile: string;
  home: string;
  workingDir: string;
}

export interface ServiceStatus {
  supported: boolean;
  kind: 'launchd' | 'systemd' | 'schtasks' | 'none';
  installed: boolean;
  running: boolean;
  pid?: number;
  file?: string;
  detail?: string;
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** LaunchAgent do macOS: sobe no login e é reiniciado se cair. */
export function launchdPlist(spec: ServiceSpec): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(spec.node)}</string>
    <string>${xml(spec.serverEntry)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENT_OFFICE_PORT</key>
    <string>${spec.port}</string>
    <key>AGENT_OFFICE_HOME</key>
    <string>${xml(spec.home)}</string>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(spec.workingDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(spec.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(spec.logFile)}</string>
</dict>
</plist>
`;
}

/** Unidade systemd --user do Linux. */
export function systemdUnit(spec: ServiceSpec): string {
  return `[Unit]
Description=agent-office — escritório 2D dos seus agentes de código
After=default.target

[Service]
ExecStart="${spec.node}" "${spec.serverEntry}"
Environment=AGENT_OFFICE_PORT=${spec.port}
Environment=AGENT_OFFICE_HOME=${spec.home}
WorkingDirectory=${spec.workingDir}
Restart=always
RestartSec=3
StandardOutput=append:${spec.logFile}
StandardError=append:${spec.logFile}

[Install]
WantedBy=default.target
`;
}

/** Argumentos do `schtasks /Create` (Tarefa Agendada do Windows, no logon). */
export function windowsTaskArgs(spec: ServiceSpec): string[] {
  return [
    '/Create',
    '/TN',
    WINDOWS_TASK,
    '/TR',
    `"${spec.node}" "${spec.serverEntry}"`,
    '/SC',
    'ONLOGON',
    '/RL',
    'LIMITED',
    '/F',
  ];
}

function sh(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
    return { ok: true, out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` || e.message };
  }
}

function launchdPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}
function systemdPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', SYSTEMD_UNIT);
}
function guiDomain(): string {
  return `gui/${userInfo().uid}`;
}

export function buildSpec(paths: Paths, port: number, node: string = process.execPath): ServiceSpec {
  return {
    node,
    serverEntry: paths.serverEntry,
    port,
    logFile: join(paths.logs, 'server.log'),
    home: paths.home,
    workingDir: paths.home,
  };
}

export function serviceStatus(): ServiceStatus {
  if (process.platform === 'darwin') {
    const file = launchdPath();
    const installed = existsSync(file);
    const r = sh('launchctl', ['print', `${guiDomain()}/${SERVICE_LABEL}`]);
    if (!r.ok) return { supported: true, kind: 'launchd', installed, running: false, file, detail: 'não carregado' };
    const state = r.out.match(/^\s*state = (.+)$/m)?.[1]?.trim();
    const pid = Number(r.out.match(/^\s*pid = (\d+)$/m)?.[1]);
    return {
      supported: true,
      kind: 'launchd',
      installed,
      running: state === 'running',
      ...(pid > 0 ? { pid } : {}),
      file,
      detail: state ?? 'desconhecido',
    };
  }
  if (process.platform === 'linux') {
    const file = systemdPath();
    const active = sh('systemctl', ['--user', 'is-active', SYSTEMD_UNIT]);
    const pid = Number(sh('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', SYSTEMD_UNIT]).out.trim());
    return {
      supported: true,
      kind: 'systemd',
      installed: existsSync(file),
      running: active.out.trim() === 'active',
      ...(pid > 0 ? { pid } : {}),
      file,
      detail: active.out.trim(),
    };
  }
  if (process.platform === 'win32') {
    const q = sh('schtasks', ['/Query', '/TN', WINDOWS_TASK, '/FO', 'LIST']);
    return {
      supported: true,
      kind: 'schtasks',
      installed: q.ok,
      running: /Status:\s+Running/i.test(q.out),
      detail: q.ok ? 'tarefa registrada' : 'tarefa não encontrada',
    };
  }
  return { supported: false, kind: 'none', installed: false, running: false };
}

/** Instala e inicia o serviço de inicialização automática. */
export function installService(spec: ServiceSpec): { ok: boolean; detail: string } {
  mkdirSync(dirname(spec.logFile), { recursive: true });
  if (process.platform === 'darwin') {
    const file = launchdPath();
    mkdirSync(dirname(file), { recursive: true });
    const target = `${guiDomain()}/${SERVICE_LABEL}`;
    sh('launchctl', ['bootout', target]);
    writeFileSync(file, launchdPlist(spec));
    let r = sh('launchctl', ['bootstrap', guiDomain(), file]);
    if (!r.ok) {
      // bootout é assíncrono: uma segunda tentativa costuma resolver "Input/output error".
      execFileSync('sleep', ['1']);
      r = sh('launchctl', ['bootstrap', guiDomain(), file]);
    }
    if (!r.ok) return { ok: false, detail: `launchctl bootstrap falhou: ${r.out.trim()}` };
    sh('launchctl', ['enable', target]);
    return { ok: true, detail: file };
  }
  if (process.platform === 'linux') {
    const file = systemdPath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, systemdUnit(spec));
    sh('systemctl', ['--user', 'daemon-reload']);
    const r = sh('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT]);
    if (!r.ok) return { ok: false, detail: `systemctl falhou: ${r.out.trim()}` };
    sh('systemctl', ['--user', 'restart', SYSTEMD_UNIT]);
    return { ok: true, detail: file };
  }
  if (process.platform === 'win32') {
    const r = sh('schtasks', windowsTaskArgs(spec));
    if (!r.ok) return { ok: false, detail: `schtasks falhou: ${r.out.trim()}` };
    sh('schtasks', ['/Run', '/TN', WINDOWS_TASK]);
    return { ok: true, detail: `Tarefa Agendada "${WINDOWS_TASK}"` };
  }
  return { ok: false, detail: 'sistema operacional não suportado' };
}

export function uninstallService(): { ok: boolean; detail: string } {
  if (process.platform === 'darwin') {
    sh('launchctl', ['bootout', `${guiDomain()}/${SERVICE_LABEL}`]);
    rmSync(launchdPath(), { force: true });
    return { ok: true, detail: 'LaunchAgent removido' };
  }
  if (process.platform === 'linux') {
    sh('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
    rmSync(systemdPath(), { force: true });
    sh('systemctl', ['--user', 'daemon-reload']);
    return { ok: true, detail: 'unidade systemd removida' };
  }
  if (process.platform === 'win32') {
    sh('schtasks', ['/End', '/TN', WINDOWS_TASK]);
    const r = sh('schtasks', ['/Delete', '/TN', WINDOWS_TASK, '/F']);
    return { ok: r.ok, detail: r.ok ? 'Tarefa Agendada removida' : r.out.trim() };
  }
  return { ok: false, detail: 'sistema operacional não suportado' };
}

/** Reinicia o serviço (usado para verificar que ele volta sozinho). */
export function restartService(): { ok: boolean; detail: string } {
  if (process.platform === 'darwin') {
    const r = sh('launchctl', ['kickstart', '-k', `${guiDomain()}/${SERVICE_LABEL}`]);
    return { ok: r.ok, detail: r.out.trim() };
  }
  if (process.platform === 'linux') {
    const r = sh('systemctl', ['--user', 'restart', SYSTEMD_UNIT]);
    return { ok: r.ok, detail: r.out.trim() };
  }
  if (process.platform === 'win32') {
    sh('schtasks', ['/End', '/TN', WINDOWS_TASK]);
    const r = sh('schtasks', ['/Run', '/TN', WINDOWS_TASK]);
    return { ok: r.ok, detail: r.out.trim() };
  }
  return { ok: false, detail: 'sistema operacional não suportado' };
}

/** Para o serviço sem desinstalar (volta no próximo login). */
export function stopService(): { ok: boolean; detail: string } {
  if (process.platform === 'darwin') {
    const r = sh('launchctl', ['bootout', `${guiDomain()}/${SERVICE_LABEL}`]);
    return { ok: r.ok, detail: r.out.trim() };
  }
  if (process.platform === 'linux') {
    const r = sh('systemctl', ['--user', 'stop', SYSTEMD_UNIT]);
    return { ok: r.ok, detail: r.out.trim() };
  }
  if (process.platform === 'win32') {
    const r = sh('schtasks', ['/End', '/TN', WINDOWS_TASK]);
    return { ok: r.ok, detail: r.out.trim() };
  }
  return { ok: false, detail: 'sistema operacional não suportado' };
}

/** Carrega de novo um serviço instalado que foi parado. */
export function startService(): { ok: boolean; detail: string } {
  if (process.platform === 'darwin') {
    const file = launchdPath();
    if (!existsSync(file)) return { ok: false, detail: 'serviço não instalado' };
    const loaded = sh('launchctl', ['print', `${guiDomain()}/${SERVICE_LABEL}`]).ok;
    const r = loaded
      ? sh('launchctl', ['kickstart', `${guiDomain()}/${SERVICE_LABEL}`])
      : sh('launchctl', ['bootstrap', guiDomain(), file]);
    return { ok: r.ok, detail: r.out.trim() };
  }
  if (process.platform === 'linux') {
    const r = sh('systemctl', ['--user', 'start', SYSTEMD_UNIT]);
    return { ok: r.ok, detail: r.out.trim() };
  }
  if (process.platform === 'win32') {
    const r = sh('schtasks', ['/Run', '/TN', WINDOWS_TASK]);
    return { ok: r.ok, detail: r.out.trim() };
  }
  return { ok: false, detail: 'sistema operacional não suportado' };
}
