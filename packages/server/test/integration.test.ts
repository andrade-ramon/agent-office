import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createApp, type AgentOfficeApp, type AppOptions } from '../src/app.js';
import type { ServerMessage, SessionState } from '../src/schema.js';

interface Client {
  ws: WebSocket;
  messages: ServerMessage[];
  waitFor<T extends ServerMessage>(pred: (m: ServerMessage) => m is T, timeoutMs?: number): Promise<T>;
  close(): void;
}

function connect(port: number, headers: Record<string, string> = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    const messages: ServerMessage[] = [];
    const waiters: { pred: (m: ServerMessage) => boolean; done: (m: ServerMessage) => void }[] = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMessage;
      messages.push(msg);
      for (const w of [...waiters]) {
        if (w.pred(msg)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.done(msg);
        }
      }
    });
    ws.once('error', reject);
    ws.once('open', () =>
      resolve({
        ws,
        messages,
        waitFor(pred, timeoutMs = 5000) {
          const existing = messages.find(pred);
          if (existing) return Promise.resolve(existing);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('timeout esperando mensagem do WebSocket')), timeoutMs);
            waiters.push({
              pred,
              done: (m) => {
                clearTimeout(timer);
                res(m as never);
              },
            });
          });
        },
        close: () => ws.close(),
      }),
    );
  });
}

function post(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* corpo não-JSON */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* corpo não-JSON */
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const isSession = (key: string, status?: string) =>
  (m: ServerMessage): m is Extract<ServerMessage, { type: 'session' }> =>
    m.type === 'session' && m.session.key === key && (!status || m.session.status === status);

describe('integração: evento → servidor → WebSocket', () => {
  let app: AgentOfficeApp | undefined;
  let tmp: string | undefined;
  const clients: Client[] = [];

  async function start(opts: Partial<AppOptions> = {}): Promise<number> {
    app = await createApp({ port: 0, dbPath: ':memory:', watch: false, version: 'test', ...opts });
    return app.listen();
  }

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await app?.close();
    app = undefined;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it('entrega um evento de hook aos clientes WebSocket e ao histórico', async () => {
    const port = await start();
    const client = await connect(port);
    clients.push(client);
    const hello = await client.waitFor((m): m is Extract<ServerMessage, { type: 'hello' }> => m.type === 'hello');
    expect(hello).toMatchObject({ version: 'test', demo: false, sessions: [] });

    const envelope = (payload: Record<string, unknown>) => ({
      agent: 'claude',
      payload: { session_id: 'sess-1', cwd: '/Users/ana/github/loja', ...payload },
    });

    const res = await post(port, '/events', envelope({ hook_event_name: 'SessionStart', source: 'startup' }));
    expect(res).toEqual({ status: 200, json: { ok: true, accepted: 1 } });
    await client.waitFor(isSession('claude:sess-1', 'starting'));

    await post(port, '/events', envelope({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_1' }));
    const working = await client.waitFor(isSession('claude:sess-1', 'working'));
    expect(working.session).toMatchObject({
      agent: 'claude',
      project: 'loja',
      toolCategory: 'bash',
      toolName: 'Bash',
      sources: { hook: true, watcher: false },
    });
    const event = await client.waitFor(
      (m): m is Extract<ServerMessage, { type: 'event' }> => m.type === 'event' && m.event.event === 'tool_start',
    );
    expect(event).toMatchObject({ key: 'claude:sess-1', event: { toolCategory: 'bash', source: 'hook' } });

    await post(port, '/events', envelope({ hook_event_name: 'SessionEnd', reason: 'other' }));
    await client.waitFor(isSession('claude:sess-1', 'ended'));

    const sessions = (await get(port, '/api/sessions')).json as { sessions: SessionState[] };
    expect(sessions.sessions.map((s) => s.key)).toEqual(['claude:sess-1']);
    const stats = (await get(port, '/api/stats')).json as { today: { events: number; tools: number; byAgent: Record<string, number> } };
    expect(stats.today).toMatchObject({ events: 3, tools: 1, byAgent: { claude: 3 } });
    const health = (await get(port, '/api/health')).json as { ok: boolean; host: string; events: { hook: number }; lastHookAt: { claude: number | null } };
    expect(health).toMatchObject({ ok: true, host: '127.0.0.1', events: { hook: 3 } });
    expect(health.lastHookAt.claude).toBeTypeOf('number');
  });

  it('aceita eventos já normalizados e rejeita corpos inválidos', async () => {
    const port = await start();
    const ok = await post(port, '/events', {
      events: [
        { agent: 'codex', sessionId: 'c1', cwd: '/repo/api', event: 'prompt', ts: Date.now() },
        { agent: 'x', sessionId: 'c1', event: 'prompt' },
        { agent: 'codex', sessionId: 'c1', event: 'inventado' },
      ],
    });
    expect(ok.json).toEqual({ ok: true, accepted: 1 });
    expect(app!.store.get('codex:c1')).toMatchObject({ status: 'thinking', project: 'api' });
    expect((await post(port, '/events', { nada: true })).status).toBe(400);
  });

  it('só atende loopback: bloqueia Host e Origin externos', async () => {
    const port = await start();
    expect((await get(port, '/api/health', { host: 'evil.example' })).status).toBe(403);
    expect((await get(port, '/api/health', { host: `localhost:${port}` })).status).toBe(200);
    const crossSite = await post(port, '/events', { agent: 'claude', payload: {} }, { origin: 'https://evil.example' });
    expect(crossSite.status).toBe(403);
    await expect(connect(port, { origin: 'https://evil.example' })).rejects.toThrow();
    const local = await connect(port, { origin: `http://localhost:${port}` });
    clients.push(local);
    expect(local.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('eventos de diagnóstico do doctor não criam personagens', async () => {
    const port = await start();
    const res = await post(port, '/events', {
      agent: 'claude',
      payload: { hook_event_name: 'SessionStart', session_id: 'agent-office-doctor-1', cwd: '/' },
    });
    expect(res.json).toMatchObject({ ok: true, accepted: 0, doctor: true });
    expect(app!.store.size).toBe(0);
  });

  it('o watcher de arquivos alimenta o mesmo fluxo (transcript do Claude e rollout do Codex)', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'agent-office-test-'));
    const claudeDir = join(tmp, 'claude', 'projects');
    const codexDir = join(tmp, 'codex', 'sessions');
    const project = join(claudeDir, '-Users-ana-loja');
    const day = join(codexDir, '2026', '11', '13');
    mkdirSync(project, { recursive: true });
    mkdirSync(day, { recursive: true });

    const port = await start({ watch: { claudeDir, codexDir, claudeSessionsDir: false, usePolling: true } });
    const client = await connect(port);
    clients.push(client);

    const ts = () => new Date().toISOString();
    const transcript = join(project, 'sess-w.jsonl');
    const jsonl = (o: unknown) => `${JSON.stringify(o)}\n`;
    writeFileSync(
      transcript,
      jsonl({ type: 'user', sessionId: 'sess-w', cwd: '/Users/ana/loja', timestamp: ts(), message: { role: 'user', content: 'oi' } }),
    );
    await client.waitFor(isSession('claude:sess-w', 'thinking'));
    appendFileSync(
      transcript,
      jsonl({
        type: 'assistant',
        sessionId: 'sess-w',
        cwd: '/Users/ana/loja',
        timestamp: ts(),
        message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_w', name: 'Grep', input: {} }] },
      }),
    );
    const working = await client.waitFor(isSession('claude:sess-w', 'working'));
    expect(working.session).toMatchObject({ toolCategory: 'search', project: 'loja', sources: { hook: false, watcher: true } });

    const id = '01a1d277-ce8c-70f0-8553-f45aa93772ef';
    writeFileSync(
      join(day, `rollout-2026-11-13T10-00-00-${id}.jsonl`),
      jsonl({ timestamp: ts(), type: 'session_meta', payload: { id, cwd: '/repo/api', originator: 'codex_cli' } }) +
        jsonl({ timestamp: ts(), type: 'event_msg', payload: { type: 'task_started' } }) +
        jsonl({ timestamp: ts(), type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', call_id: 'c1' } }),
    );
    const codex = await client.waitFor(isSession(`codex:${id}`, 'working'));
    expect(codex.session).toMatchObject({ agent: 'codex', toolCategory: 'edit', project: 'api', entrypoint: 'codex_cli' });
  });
});
