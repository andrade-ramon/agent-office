#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// O módulo nativo node:sqlite ainda emite um aviso "experimental" em algumas
// versões do Node; ele é carregado sob demanda, depois deste filtro.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (/SQLite is an experimental feature/i.test(text)) return;
  (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const { createApp } = await import('./app.js');
const { DEMO_PORT, HOST, loadConfig, officeHome } = await import('./config.js');

const here = dirname(fileURLToPath(import.meta.url));

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

interface Args {
  demo: boolean;
  open: boolean;
  watch: boolean;
  port?: number;
  db?: string;
  speed?: number;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { demo: false, open: false, watch: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--demo') args.demo = true;
    else if (a === '--open') args.open = true;
    else if (a === '--no-watch') args.watch = false;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--port' || a === '-p') args.port = Number(argv[++i]);
    else if (a?.startsWith('--port=')) args.port = Number(a.slice(7));
    else if (a === '--db') args.db = argv[++i];
    else if (a === '--speed') args.speed = Number(argv[++i]);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`agent-office server

Uso: node dist/index.js [opções]
  --port <n>    porta (padrão 4747; 4748 no modo demo)
  --demo        simula sessões (não lê transcripts nem grava histórico)
  --open        abre o navegador
  --no-watch    desativa os watchers de arquivo
  --db <path>   caminho do SQLite`);
  process.exit(0);
}

const config = loadConfig();
const home = officeHome();
const port = Number.isFinite(args.port) && args.port! >= 0 ? args.port! : args.demo ? DEMO_PORT : config.port;

let dbPath = ':memory:';
if (!args.demo) {
  mkdirSync(home, { recursive: true });
  dbPath = args.db ?? join(home, 'agent-office.db');
}

const webDir = [process.env.AGENT_OFFICE_WEB_DIR, resolve(here, '..', '..', 'web', 'dist')].find(
  (p): p is string => Boolean(p) && existsSync(join(p!, 'index.html')),
);

const log = (msg: string): void => console.log(`[${new Date().toISOString()}] ${msg}`);

const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');

const app = await createApp({
  port,
  version: readVersion(),
  dbPath,
  ...(webDir ? { webDir } : {}),
  demo: args.demo ? { speed: args.speed && args.speed > 0 ? args.speed : 1 } : false,
  watch:
    args.demo || !args.watch
      ? false
      : {
          claudeDir: join(claudeHome, 'projects'),
          codexDir: join(codexHome, 'sessions'),
          claudeSessionsDir: join(claudeHome, 'sessions'),
          codexIndexFile: join(codexHome, 'session_index.jsonl'),
        },
  store: {
    idleAfterMs: config.idleAfterMin * 60_000,
    endAfterMs: config.endAfterMin * 60_000,
    titles: config.titles,
  },
  log,
});

let closing = false;
const shutdown = (signal: string): void => {
  if (closing) return;
  closing = true;
  log(`encerrando (${signal})`);
  const force = setTimeout(() => process.exit(0), 3000);
  force.unref();
  app.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

try {
  const actual = await app.listen();
  const url = `http://localhost:${actual}`;
  log(`agent-office no ar em ${url} (escutando somente em ${HOST})${args.demo ? ' — MODO DEMO' : ''}`);
  if (!webDir) log('front-end não compilado: rode "npm run build"');
  if (args.open) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const openArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    execFile(opener, openArgs, () => undefined);
  }
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EADDRINUSE') {
    console.error(`A porta ${port} já está em uso. O agent-office já está rodando? (agent-office status)`);
  } else {
    console.error(`Falha ao iniciar: ${String(err)}`);
  }
  process.exit(1);
}
