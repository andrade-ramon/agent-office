import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { ensureDirs, HOST, type Paths } from './paths.js';

export interface Health {
  ok: boolean;
  name: string;
  version: string;
  host: string;
  port: number;
  pid: number;
  uptimeMs: number;
  demo: boolean;
  sessions: number;
  clients: number;
  events: { total: number; hook: number; watcher: number };
  lastHookAt: { claude: number | null; codex: number | null };
  watcher: { enabled: boolean; claudeFiles: number; codexFiles: number; tracked: number };
  webBuilt: boolean;
  voiceAlert?: { enabled: boolean; pending: number };
}

export function httpGet(port: number, path: string, timeoutMs = 1500): Promise<{ status: number; body: string } | null> {
  return new Promise((resolve) => {
    const req = request({ host: HOST, port, path, method: 'GET', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

export async function getHealth(port: number, timeoutMs = 1500): Promise<Health | null> {
  const res = await httpGet(port, '/api/health', timeoutMs);
  if (!res || res.status !== 200) return null;
  try {
    const parsed = JSON.parse(res.body) as Health;
    return parsed.name === 'agent-office' ? parsed : null;
  } catch {
    return null;
  }
}

export async function waitForHealth(port: number, timeoutMs = 10_000): Promise<Health | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await getHealth(port, 800);
    if (h) return h;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

export async function waitForDown(port: number, timeoutMs = 6000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await getHealth(port, 500))) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** true se algo aceita conexões TCP em host:port. */
export function canConnect(host: string, port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (v: boolean): void => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** Sobe o servidor em segundo plano (sem serviço do SO). */
export function startDetached(paths: Paths, port: number, extraArgs: string[] = []): number {
  ensureDirs(paths);
  const log = openSync(join(paths.logs, 'server.log'), 'a');
  const child = spawn(process.execPath, [paths.serverEntry, '--port', String(port), ...extraArgs], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, AGENT_OFFICE_HOME: paths.home },
    windowsHide: true,
  });
  child.unref();
  if (child.pid) writeFileSync(paths.pidFile, String(child.pid));
  return child.pid ?? 0;
}

export function readPidFile(paths: Paths): number | null {
  try {
    const pid = Number(readFileSync(paths.pidFile, 'utf8').trim());
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function killPid(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

export function clearPidFile(paths: Paths): void {
  if (existsSync(paths.pidFile)) rmSync(paths.pidFile, { force: true });
}
