import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_EVENTS,
  claudeHandlers,
  codexHandlers,
  codexTrust,
  claudeSettingsProblems,
  connectTarget,
  disconnectTarget,
  fixClaudeSettings,
  hookCommand,
  installHookFiles,
  installedCount,
  launcherContent,
  parseVersion,
  versionGte,
} from '../src/install.js';
import { getPaths, HOOK_MARKER, type Paths } from '../src/paths.js';
import { launchdPlist, systemdUnit, windowsTaskArgs, type ServiceSpec } from '../src/service.js';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK_SOURCE = resolve(here, '..', 'hook', 'agent-office-hook.mjs');

let tmp: string;
let paths: Paths;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ao-cli-test-'));
  paths = {
    ...getPaths({ AGENT_OFFICE_HOME: join(tmp, 'office'), CLAUDE_CONFIG_DIR: join(tmp, 'claude'), CODEX_HOME: join(tmp, 'codex') }),
    hookSource: HOOK_SOURCE,
  };
  mkdirSync(paths.claudeHome, { recursive: true });
  mkdirSync(paths.codexHome, { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const ORIGINAL = `{
  "model": "opus",
  "hooks": {
    "Notification": [
      {
        "matcher": "",
        "hooks": []
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "codegraph prompt-hook"
          }
        ]
      }
    ]
  },
  "permissions": { "allow": ["Bash(npm test)"] }
}
`;

describe('connect / disconnect no settings.json do Claude Code', () => {
  const events = CLAUDE_EVENTS.map((e) => e.event);
  const connect = () => connectTarget(paths, 'claude', paths.claudeSettings, claudeHandlers(paths.hookLauncher));

  it('faz backup, mescla com os hooks existentes e não perde nada', () => {
    writeFileSync(paths.claudeSettings, ORIGINAL);
    const r = connect();
    expect(r.status).toBe('installed');
    expect(r.backup && readFileSync(r.backup, 'utf8')).toBe(ORIGINAL);

    const after = JSON.parse(readFileSync(paths.claudeSettings, 'utf8'));
    expect(after.model).toBe('opus');
    expect(after.permissions).toEqual({ allow: ['Bash(npm test)'] });
    expect(after.hooks.Notification[0]).toEqual({ matcher: '', hooks: [] });
    expect(after.hooks.UserPromptSubmit[0]).toEqual({ hooks: [{ type: 'command', command: 'codegraph prompt-hook' }] });
    expect(after.hooks.UserPromptSubmit[1].hooks[0].command).toContain(HOOK_MARKER);
    expect(installedCount(paths.claudeSettings, events)).toBe(events.length);
    // hooks de ferramenta não bloqueiam o agente
    expect(after.hooks.PreToolUse[0].hooks[0]).toMatchObject({ type: 'command', async: true, timeout: 5 });
    expect(after.hooks.SessionEnd[0].hooks[0].async).toBeUndefined();
  });

  it('é idempotente: conectar de novo não altera o arquivo nem cria backup', () => {
    writeFileSync(paths.claudeSettings, ORIGINAL);
    connect();
    const once = readFileSync(paths.claudeSettings, 'utf8');
    const backups = readdirSync(paths.backups).length;
    const again = connect();
    expect(again.status).toBe('unchanged');
    expect(readFileSync(paths.claudeSettings, 'utf8')).toBe(once);
    expect(readdirSync(paths.backups).length).toBe(backups);
    // um único handler nosso por evento (o comando cita o caminho duas vezes: `[ -x … ] && …`)
    expect(once.match(new RegExp(HOOK_MARKER, 'g'))?.length).toBe(events.length * 2);
  });

  it('disconnect restaura o arquivo original byte a byte', () => {
    writeFileSync(paths.claudeSettings, ORIGINAL);
    connect();
    connect();
    const r = disconnectTarget(paths, 'claude', paths.claudeSettings);
    expect(r).toMatchObject({ status: 'restored', removed: events.length });
    expect(readFileSync(paths.claudeSettings, 'utf8')).toBe(ORIGINAL);
    expect(disconnectTarget(paths, 'claude', paths.claudeSettings).status).toBe('nothing');
  });

  it('disconnect preserva mudanças feitas pelo usuário depois do connect', () => {
    writeFileSync(paths.claudeSettings, ORIGINAL);
    connect();
    const edited = JSON.parse(readFileSync(paths.claudeSettings, 'utf8'));
    edited.theme = 'dark';
    edited.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'meu-guard' }] });
    writeFileSync(paths.claudeSettings, JSON.stringify(edited, null, 2));
    const r = disconnectTarget(paths, 'claude', paths.claudeSettings);
    expect(r.status).toBe('removed');
    const after = JSON.parse(readFileSync(paths.claudeSettings, 'utf8'));
    expect(after.theme).toBe('dark');
    expect(after.hooks.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'meu-guard' }] }]);
    expect(after.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: 'command', command: 'codegraph prompt-hook' }] }]);
    expect(JSON.stringify(after)).not.toContain(HOOK_MARKER);
    expect(Object.keys(after.hooks).sort()).toEqual(['Notification', 'PreToolUse', 'UserPromptSubmit']);
  });

  it('cria o settings.json quando não existe e o remove no disconnect', () => {
    expect(connect().status).toBe('installed');
    expect(installedCount(paths.claudeSettings, events)).toBe(events.length);
    expect(disconnectTarget(paths, 'claude', paths.claudeSettings).status).toBe('deleted');
    expect(existsSync(paths.claudeSettings)).toBe(false);
  });

  it('não toca em um arquivo com JSON inválido', () => {
    writeFileSync(paths.claudeSettings, '{ "model": ');
    const r = connect();
    expect(r.status).toBe('error');
    expect(readFileSync(paths.claudeSettings, 'utf8')).toBe('{ "model": ');
  });
});

describe('settings.json que o Claude Code ignora', () => {
  it('detecta statusLine sem "type" e corrige preservando o resto', () => {
    expect(claudeSettingsProblems({ statusLine: { type: 'command', command: 'x' } })).toEqual([]);
    expect(claudeSettingsProblems({ model: 'opus' })).toEqual([]);
    expect(claudeSettingsProblems({ statusLine: { command: 'x' } })).toEqual([
      { key: 'statusLine.type', message: 'statusLine sem "type": "command"', fixable: true },
    ]);

    writeFileSync(paths.claudeSettings, '{\n  "model": "opus",\n  "statusLine": {\n    "command": "node status.js",\n    "padding": 0\n  },\n  "theme": "dark"\n}\n');
    const r = fixClaudeSettings(paths);
    expect(r.status).toBe('fixed');
    expect(r.backup && existsSync(r.backup)).toBe(true);
    expect(readFileSync(paths.claudeSettings, 'utf8')).toBe(
      '{\n  "model": "opus",\n  "statusLine": {\n    "type": "command",\n    "command": "node status.js",\n    "padding": 0\n  },\n  "theme": "dark"\n}\n',
    );
    expect(fixClaudeSettings(paths).status).toBe('nothing');
  });

  it('depois da correção, disconnect remove só os hooks e mantém a correção', () => {
    writeFileSync(paths.claudeSettings, '{\n  "statusLine": {\n    "command": "x"\n  }\n}\n');
    connectTarget(paths, 'claude', paths.claudeSettings, claudeHandlers(paths.hookLauncher));
    fixClaudeSettings(paths);
    expect(disconnectTarget(paths, 'claude', paths.claudeSettings).status).toBe('removed');
    expect(JSON.parse(readFileSync(paths.claudeSettings, 'utf8'))).toEqual({ statusLine: { type: 'command', command: 'x' } });
  });
});

describe('hooks do Codex', () => {
  it('respeita a versão instalada', () => {
    const modern = codexHandlers('/x/agent-office-hook', parseVersion('codex-cli 0.167.0-alpha.4.1'));
    expect(Object.keys(modern)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PermissionRequest',
      'Stop',
      'SubagentStart',
      'SubagentStop',
      'SessionEnd',
      'Interrupt',
    ]);
    expect(modern.PreToolUse).toMatchObject({ async: true });
    expect(modern.SessionEnd).toEqual({ type: 'command', command: expect.stringContaining(' codex'), timeout: 2 });

    const old = codexHandlers('/x/agent-office-hook', parseVersion('codex-cli 0.130.0'));
    expect(Object.keys(old)).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop']);
    expect(old.PreToolUse?.async).toBeUndefined();
    expect(Object.keys(codexHandlers('/x/agent-office-hook', null))).toHaveLength(6);
    expect(versionGte([0, 167, 0], [0, 148, 0])).toBe(true);
    expect(versionGte([0, 147, 9], [0, 148, 0])).toBe(false);
  });

  it('cria hooks.json, é idempotente e some no disconnect', () => {
    const handlers = codexHandlers(paths.hookLauncher, [0, 167, 0]);
    expect(connectTarget(paths, 'codex', paths.codexHooks, handlers).status).toBe('installed');
    const once = readFileSync(paths.codexHooks, 'utf8');
    expect(JSON.parse(once).hooks.Stop[0].hooks[0].command).toContain(`${HOOK_MARKER}' codex`);
    expect(connectTarget(paths, 'codex', paths.codexHooks, handlers).status).toBe('unchanged');
    expect(readFileSync(paths.codexHooks, 'utf8')).toBe(once);
    expect(disconnectTarget(paths, 'codex', paths.codexHooks).status).toBe('deleted');
    expect(existsSync(paths.codexHooks)).toBe(false);
  });

  it('mescla com um hooks.json existente e o restaura', () => {
    const original = `{\n  "hooks": {\n    "Stop": [{ "hooks": [{ "type": "command", "command": "say pronto" }] }]\n  }\n}\n`;
    writeFileSync(paths.codexHooks, original);
    const handlers = codexHandlers(paths.hookLauncher, [0, 167, 0]);
    connectTarget(paths, 'codex', paths.codexHooks, handlers);
    const merged = JSON.parse(readFileSync(paths.codexHooks, 'utf8'));
    expect(merged.hooks.Stop).toHaveLength(2);
    expect(merged.hooks.Stop[0].hooks[0].command).toBe('say pronto');
    expect(disconnectTarget(paths, 'codex', paths.codexHooks).status).toBe('restored');
    expect(readFileSync(paths.codexHooks, 'utf8')).toBe(original);
  });

  it('lê o estado de aprovação (trust) do config.toml', () => {
    const events = ['SessionStart', 'PreToolUse', 'Stop'];
    expect(codexTrust(paths, events)).toEqual({ trusted: 0, total: 3 });
    writeFileSync(
      paths.codexConfig,
      `model = "gpt"\n\n[hooks.state."file:${paths.codexHooks}:session_start:0:0"]\nenabled = true\ntrusted_hash = "abc"\n\n` +
        `[hooks.state."file:${paths.codexHooks}:pre_tool_use:0:0"]\ntrusted_hash = "def"\n\n` +
        `[hooks.state."file:/outro/hooks.json:stop:0:0"]\ntrusted_hash = "zzz"\n`,
    );
    expect(codexTrust(paths, events)).toEqual({ trusted: 2, total: 3 });
  });
});

describe('script de hook (fail-open e privacidade)', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  const run = (payload: unknown, env: Record<string, string>, agent = 'claude') => {
    const t0 = Date.now();
    const r = spawnSync(paths.hookLauncher, [agent], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      env: { ...process.env, AGENT_OFFICE_HOME: paths.home, ...env },
      encoding: 'utf8',
      timeout: 10_000,
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t0 };
  };

  it('gera um comando que sempre termina com 0', () => {
    expect(hookCommand('/a b/agent-office-hook', 'claude', 'darwin')).toBe(
      `[ -x '/a b/agent-office-hook' ] && '/a b/agent-office-hook' claude || true`,
    );
    expect(hookCommand('C:\\x\\agent-office-hook.cmd', 'codex', 'win32')).toBe('"C:\\x\\agent-office-hook.cmd" codex');
    expect(launcherContent('/n/node', '/h/hook.mjs', 'linux')).toContain('exit 0');
    // comando apontando para um lançador que não existe: silêncio e exit 0
    const out = execFileSync('/bin/sh', ['-c', hookCommand(join(tmp, 'nao-existe'), 'claude', 'darwin')], { encoding: 'utf8' });
    expect(out).toBe('');
  });

  it.skipIf(process.platform === 'win32')('envia só metadados para o servidor local', async () => {
    installHookFiles(paths);
    const received: { url?: string; body: string }[] = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ url: req.url, body });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = String((server.address() as AddressInfo).port);

    const r = run(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'sess-1',
        cwd: '/Users/ana/loja',
        transcript_path: '/Users/ana/.claude/projects/x/sess-1.jsonl',
        tool_name: 'Bash',
        tool_use_id: 'toolu_1',
        session_title: 'Corrigir frete no checkout',
        tool_input: { command: 'cat ~/.ssh/id_rsa # SEGREDO' },
        prompt: 'SEGREDO do prompt',
        last_assistant_message: 'SEGREDO da resposta',
        tool_response: { stdout: 'SEGREDO da saída' },
      },
      { AGENT_OFFICE_PORT: port },
    );
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
    await new Promise((res) => setTimeout(res, 50));
    expect(received).toHaveLength(1);
    expect(received[0]!.url).toBe('/events');
    expect(received[0]!.body).not.toContain('SEGREDO');
    const sent = JSON.parse(received[0]!.body);
    expect(sent.agent).toBe('claude');
    expect(sent.payload).toEqual({
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      cwd: '/Users/ana/loja',
      tool_name: 'Bash',
      tool_use_id: 'toolu_1',
      session_title: 'Corrigir frete no checkout',
    });
    expect(sent.pid).toBeUndefined();

    run({ hook_event_name: 'SessionStart', session_id: 'sess-2', cwd: '/x', source: 'startup' }, { AGENT_OFFICE_PORT: port }, 'codex');
    await new Promise((res) => setTimeout(res, 50));
    const start = JSON.parse(received[1]!.body);
    expect(start.agent).toBe('codex');
    expect(start.pid).toBeTypeOf('number');
  });

  it.skipIf(process.platform === 'win32')('com o servidor fora do ar sai com 0, rápido e sem saída', () => {
    installHookFiles(paths);
    const down = run({ hook_event_name: 'PreToolUse', session_id: 's', cwd: '/' }, { AGENT_OFFICE_PORT: '9' });
    expect(down).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(down.ms).toBeLessThan(2500);
    expect(run('isto não é json', { AGENT_OFFICE_PORT: '9' })).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(run('', { AGENT_OFFICE_PORT: '9' })).toMatchObject({ code: 0, stdout: '' });
  });

  it.skipIf(process.platform === 'win32')('um servidor que nunca responde não segura o agente', async () => {
    installHookFiles(paths);
    server = createServer(() => {
      /* aceita a conexão e nunca responde */
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = String((server.address() as AddressInfo).port);
    const r = run({ hook_event_name: 'Stop', session_id: 's', cwd: '/' }, { AGENT_OFFICE_PORT: port });
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(2500);
    server.closeAllConnections();
  });
});

describe('inicialização automática', () => {
  const spec: ServiceSpec = {
    node: '/opt/node/bin/node',
    serverEntry: '/repo/packages/server/dist/index.js',
    port: 4747,
    logFile: '/home/u/.agent-office/logs/server.log',
    home: '/home/u/.agent-office',
    workingDir: '/home/u/.agent-office',
  };

  it('gera um LaunchAgent que sobe no login e reinicia sozinho', () => {
    const plist = launchdPlist(spec);
    expect(plist).toContain('<string>com.agent-office.server</string>');
    expect(plist).toContain('<string>/opt/node/bin/node</string>');
    expect(plist).toContain('<string>/repo/packages/server/dist/index.js</string>');
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>AGENT_OFFICE_PORT<\/key>\s*<string>4747<\/string>/);
  });

  it('gera a unidade systemd e a tarefa agendada', () => {
    const unit = systemdUnit(spec);
    expect(unit).toContain('ExecStart="/opt/node/bin/node" "/repo/packages/server/dist/index.js"');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('WantedBy=default.target');
    expect(windowsTaskArgs(spec)).toEqual(expect.arrayContaining(['/SC', 'ONLOGON', '/TN', 'agent-office']));
  });
});
