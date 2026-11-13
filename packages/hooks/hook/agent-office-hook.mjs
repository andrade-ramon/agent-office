#!/usr/bin/env node
// agent-office — script de hook para Claude Code e Codex.
//
// Regras deste arquivo:
//   • fail-open: NUNCA atrasa, quebra ou bloqueia o agente. Qualquer erro,
//     servidor fora do ar ou demora → sai com código 0, em silêncio.
//   • privacidade: envia somente metadados (lista ALLOW abaixo). Prompts,
//     respostas, entradas/saídas de ferramentas e conteúdo de arquivos são
//     descartados aqui mesmo, antes de qualquer envio.
//   • só fala com 127.0.0.1.
//
// Uso (configurado pelo `agent-office connect`):
//   agent-office-hook.mjs <claude|codex>     (payload do hook em stdin)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

const exit = () => process.exit(0);
process.on('uncaughtException', exit);
process.on('unhandledRejection', exit);

// Teto absoluto de execução, aconteça o que acontecer.
const HARD_LIMIT_MS = 1200;
const HTTP_TIMEOUT_MS = 400;
setTimeout(exit, HARD_LIMIT_MS);

const agent = process.argv[2] === 'codex' ? 'codex' : 'claude';

/** Únicos campos do payload repassados ao servidor local. */
const ALLOW = [
  'hook_event_name',
  'session_id',
  'cwd',
  'tool_name',
  'tool_use_id',
  'source',
  'reason',
  'notification_type',
  'agent_id',
  'agent_type',
  'model',
  'permission_mode',
  'is_interrupt',
];

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'tcsh', 'csh']);

function port() {
  const fromEnv = Number(process.env.AGENT_OFFICE_PORT);
  if (fromEnv > 0) return fromEnv;
  try {
    const home = process.env.AGENT_OFFICE_HOME || join(homedir(), '.agent-office');
    const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    if (Number(cfg.port) > 0) return Number(cfg.port);
  } catch {
    /* sem config: porta padrão */
  }
  return 4747;
}

/** PID do processo do agente: sobe a árvore pulando shells intermediários. */
function agentPid() {
  let pid = process.ppid;
  if (process.platform === 'win32') return pid;
  try {
    for (let i = 0; i < 4; i++) {
      const out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 250,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const m = out.match(/^(\d+)\s+(.*)$/);
      if (!m) break;
      const name = m[2].split('/').pop().replace(/^-/, '');
      if (!SHELLS.has(name)) break;
      pid = Number(m[1]);
    }
  } catch {
    /* melhor esforço */
  }
  return pid;
}

let sent = false;
function send(raw) {
  if (sent) return;
  sent = true;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return exit();
  }
  if (!input || typeof input !== 'object') return exit();

  const payload = {};
  for (const key of ALLOW) {
    const v = input[key];
    if (typeof v === 'string' ? v.length > 0 && v.length <= 1024 : typeof v === 'boolean') payload[key] = v;
  }
  if (!payload.hook_event_name || !payload.session_id) return exit();

  const envelope = { agent, payload, ts: Date.now() };
  // O PID só interessa uma vez por sessão (para trazer a janela para frente).
  if (payload.hook_event_name === 'SessionStart') envelope.pid = agentPid();

  const body = JSON.stringify(envelope);
  const req = request(
    {
      host: '127.0.0.1',
      port: port(),
      path: '/events',
      method: 'POST',
      timeout: HTTP_TIMEOUT_MS,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    },
    (res) => {
      res.resume();
      res.on('end', exit);
      res.on('error', exit);
    },
  );
  req.on('timeout', () => {
    req.destroy();
    exit();
  });
  req.on('error', exit);
  req.end(body);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
  if (raw.length > 16_000_000) {
    raw = '';
    exit();
  }
});
process.stdin.on('end', () => send(raw));
process.stdin.on('error', exit);
