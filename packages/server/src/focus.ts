import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { FocusResponse, SessionState } from './schema.js';

function run(cmd: string, args: string[], timeoutMs = 2500): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve({ ok: !err, stdout: String(stdout ?? '').trim() });
    });
  });
}

interface ProcInfo {
  pid: number;
  ppid: number;
  comm: string;
}

async function procInfo(pid: number): Promise<ProcInfo | null> {
  const r = await run('ps', ['-o', 'ppid=,comm=', '-p', String(pid)]);
  if (!r.ok || !r.stdout) return null;
  const m = r.stdout.match(/^\s*(\d+)\s+(.*)$/);
  if (!m) return null;
  return { pid, ppid: Number(m[1]), comm: m[2] ?? '' };
}

/**
 * Sobe a árvore de processos e devolve o app (.app) mais externo: o próprio
 * agente pode rodar de dentro de um bundle auxiliar (ex.: o claude.app embutido
 * no app de desktop), e o que interessa é a janela que o hospeda.
 */
async function findMacApp(pid: number): Promise<string | null> {
  let current = pid;
  let found: string | null = null;
  for (let i = 0; i < 16 && current > 1; i++) {
    const info = await procInfo(current);
    if (!info) break;
    const idx = info.comm.indexOf('.app/');
    if (idx > 0) found = info.comm.slice(0, idx + 4);
    current = info.ppid;
  }
  return found;
}

async function ttyOf(pid: number): Promise<string | null> {
  const r = await run('ps', ['-o', 'tty=', '-p', String(pid)]);
  const tty = r.stdout.trim();
  if (!r.ok || !tty || tty.startsWith('?')) return null;
  return tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
}

const TERMINAL_SCRIPT = (tty: string) => `
tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${tty}" then
        set selected of t to true
        set index of w to 1
        activate
        return "ok"
      end if
    end repeat
  end repeat
end tell
return "none"`;

const ITERM_SCRIPT = (tty: string) => `
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "${tty}" then
          select w
          tell t to select
          tell s to select
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
end tell
return "none"`;

const DESKTOP_APPS: Record<string, string[]> = {
  claude: ['/Applications/Claude.app'],
  codex: ['/Applications/Codex.app', '/Applications/ChatGPT.app'],
};

async function focusMac(s: SessionState): Promise<FocusResponse> {
  let bundle: string | null = null;
  let tty: string | null = null;
  if (s.pid) {
    bundle = await findMacApp(s.pid);
    tty = await ttyOf(s.pid);
  }
  if (!bundle && /desktop/i.test(s.entrypoint ?? '')) {
    bundle = (DESKTOP_APPS[s.agent] ?? []).find((p) => existsSync(p)) ?? null;
  }
  if (!bundle) {
    return { ok: false, detail: 'Não foi possível localizar a janela desta sessão (processo desconhecido).' };
  }
  const name = bundle.split('/').pop()!.replace(/\.app$/, '');
  if (tty && /^(Terminal|iTerm)/.test(name) && /^\/dev\/tty[a-z0-9]+$/.test(tty)) {
    const script = name.startsWith('iTerm') ? ITERM_SCRIPT(tty) : TERMINAL_SCRIPT(tty);
    const r = await run('osascript', ['-e', script], 4000);
    if (r.ok && r.stdout === 'ok') return { ok: true, detail: `${name}: aba ${tty} em primeiro plano.` };
  }
  const opened = await run('open', ['-a', bundle]);
  return opened.ok
    ? { ok: true, detail: `${name} em primeiro plano.` }
    : { ok: false, detail: `Falha ao ativar ${name}.` };
}

async function focusLinux(s: SessionState): Promise<FocusResponse> {
  if (!s.pid) return { ok: false, detail: 'PID da sessão desconhecido.' };
  let current = s.pid;
  for (let i = 0; i < 14 && current > 1; i++) {
    const r = await run('xdotool', ['search', '--pid', String(current)]);
    const win = r.stdout.split('\n').filter(Boolean).pop();
    if (r.ok && win) {
      const act = await run('xdotool', ['windowactivate', win]);
      if (act.ok) return { ok: true, detail: 'Janela ativada via xdotool.' };
    }
    const info = await procInfo(current);
    if (!info) break;
    current = info.ppid;
  }
  return { ok: false, detail: 'Não foi possível ativar a janela (requer xdotool em X11).' };
}

/** Tenta trazer para frente o terminal/app que hospeda a sessão. */
export async function focusSession(s: SessionState): Promise<FocusResponse> {
  try {
    if (process.platform === 'darwin') return await focusMac(s);
    if (process.platform === 'linux') return await focusLinux(s);
    return { ok: false, detail: 'Trazer a janela para frente ainda não é suportado neste sistema.' };
  } catch (err) {
    return { ok: false, detail: `Falha ao focar: ${String(err)}` };
  }
}
