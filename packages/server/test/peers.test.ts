import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AgentOfficeApp } from '../src/app.js';
import { isLoopbackUrl, parsePeer, peersReader, type PeerConfig } from '../src/config.js';
import { mirrorSnapshot, sshArgs } from '../src/peers.js';
import type { HealthResponse, NormalizedEvent, SessionState } from '../src/schema.js';
import { SessionStore } from '../src/state.js';

const T0 = 1_700_000_000_000;

const ev = (event: NormalizedEvent['event'], sessionId: string, extra: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  agent: 'claude',
  sessionId,
  cwd: '/Users/ana/loja',
  project: 'loja',
  event,
  toolCategory: 'other',
  ts: Date.now(),
  source: 'hook',
  ...extra,
});

async function until<T>(read: () => T | undefined | false, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condição não atingida a tempo');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function getJson<T>(port: number, path: string, method = 'GET'): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => resolve(JSON.parse(body) as T));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('mirrorSnapshot (sessão vinda de outro escritório)', () => {
  const store = new SessionStore();
  store.apply(ev('prompt', 's1', { ts: T0, meta: { title: 'Corrigir frete', pid: 4242, model: 'claude-x' } }));
  store.apply(ev('tool_start', 's1', { ts: T0 + 500, toolName: 'Bash', toolCategory: 'bash', meta: { toolUseId: 't1' } }));
  const original = store.get('claude:s1')!;
  store.dispose();

  it('copia o estado, marca a máquina e descarta o que não vale aqui', () => {
    const copy = mirrorSnapshot(JSON.parse(JSON.stringify(original)), 'macbook-casa')!;
    expect(copy).toMatchObject({
      key: 'claude:s1',
      status: 'working',
      toolName: 'Bash',
      toolCategory: 'bash',
      title: 'Corrigir frete',
      project: 'loja',
      cwd: '/Users/ana/loja',
      model: 'claude-x',
      machine: 'macbook-casa',
      statusSince: T0 + 500,
      counts: { prompts: 1, tools: 1, errors: 0 },
      sources: { hook: true, watcher: false },
    });
    expect(copy.pid).toBeUndefined(); // pid de outra máquina não significa nada aqui
    expect(copy.timeline.map((t) => t.event)).toEqual(['prompt', 'tool_start']);
  });

  it('recalcula as chaves, corrige o relógio e não confia em campos soltos', () => {
    const copy = mirrorSnapshot(
      {
        ...original,
        key: 'codex:outra-coisa',
        parentSessionId: 'pai',
        parentKey: 'qualquer',
        url: 'javascript:alert(1)',
        toolCategory: 'inventada',
        machine: 'servidor-ci',
        timeline: [{ ts: T0, event: 'tool_start', toolCategory: 'bash', source: 'hook' }, { event: 'explodir' }, 'lixo'],
        context: { tokens: 10, window: 100, pct: 7 },
      },
      'macbook-casa',
      60_000,
    )!;
    expect(copy.key).toBe('claude:s1');
    expect(copy.parentKey).toBe('claude:pai');
    expect(copy.url).toBeUndefined();
    expect(copy.toolCategory).toBeNull();
    expect(copy.machine).toBe('servidor-ci'); // veio de uma terceira máquina: mantém a origem
    expect(copy.statusSince).toBe(T0 + 500 + 60_000);
    expect(copy.timeline).toEqual([{ ts: T0 + 60_000, event: 'tool_start', toolCategory: 'bash', source: 'hook' }]);
    expect(copy.context).toEqual({ tokens: 10, window: 100, pct: 1 });

    expect(mirrorSnapshot({ ...original, agent: 'gpt' }, 'm')).toBeNull();
    expect(mirrorSnapshot({ ...original, status: 'voando' }, 'm')).toBeNull();
    expect(mirrorSnapshot('texto', 'm')).toBeNull();
  });
});

describe('sessões espelhadas no estado', () => {
  let store: SessionStore;
  beforeEach(() => {
    store = new SessionStore();
  });
  afterEach(() => store.dispose());

  const remote = (over: Partial<SessionState> = {}): SessionState =>
    mirrorSnapshot({ agent: 'claude', sessionId: 'r1', status: 'thinking', startedAt: T0, statusSince: T0, lastActivityAt: T0, title: 'Tarefa', ...over }, 'macbook-casa')!;

  it('não sofre os prazos locais nem recebe eventos daqui', () => {
    expect(store.mirror(remote())).toBe(true);
    store.tick(T0 + 5 * 60 * 60_000);
    expect(store.get('claude:r1')).toMatchObject({ status: 'thinking', machine: 'macbook-casa', title: 'Tarefa' });
    expect(store.apply(ev('stop', 'r1'))).toBe(false);
    store.end('claude:r1', T0, 'x');
    expect(store.get('claude:r1')?.status).toBe('thinking');

    store.mirror(remote({ status: 'permission_wait' }));
    expect(store.get('claude:r1')?.status).toBe('permission_wait');
    store.unmirror('claude:r1');
    expect(store.has('claude:r1')).toBe(false);
  });

  it('a sessão local tem prioridade e nunca é removida pelo espelho', () => {
    store.apply(ev('prompt', 'r1', { ts: T0 }));
    expect(store.mirror(remote())).toBe(false);
    expect(store.get('claude:r1')?.machine).toBeUndefined();
    store.unmirror('claude:r1');
    expect(store.has('claude:r1')).toBe(true);
  });

  it('respeita "titles: false"', () => {
    store.dispose();
    store = new SessionStore({ titles: false });
    store.mirror(remote());
    expect(store.get('claude:r1')?.title).toBeUndefined();
  });
});

describe('configuração de máquinas', () => {
  it('aceita destino SSH ou túnel local e recusa o resto', () => {
    expect(parsePeer({ name: 'macbook-casa', ssh: 'ramon@macbook.local' })).toEqual({ name: 'macbook-casa', ssh: 'ramon@macbook.local', remotePort: 4747 });
    expect(parsePeer({ name: 'ci', url: 'http://127.0.0.1:4751', remotePort: 5000 })).toEqual({ name: 'ci', url: 'http://127.0.0.1:4751', remotePort: 5000 });
    // "-oProxyCommand=..." seria lido pelo ssh como opção
    expect(parsePeer({ name: 'x', ssh: '-oProxyCommand=calc' })).toBeNull();
    expect(parsePeer({ name: 'x', ssh: 'host; rm -rf /' })).toBeNull();
    expect(parsePeer({ name: 'x', url: 'http://exemplo.com:4747' })).toBeNull();
    expect(parsePeer({ name: '', ssh: 'host' })).toBeNull();
    expect(parsePeer({ name: 'sem-destino' })).toBeNull();
    expect(isLoopbackUrl('http://localhost:4751')).toBe(true);
    expect(isLoopbackUrl('https://127.0.0.1.evil.com')).toBe(false);
  });

  it('o ssh só encaminha uma porta, sem comando remoto e sem perguntas', () => {
    const args = sshArgs('ramon@macbook.local', 50123, 4747);
    expect(args).toContain('-N');
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('ExitOnForwardFailure=yes');
    expect(args.slice(-4)).toEqual(['-L', '127.0.0.1:50123:127.0.0.1:4747', '--', 'ramon@macbook.local']);
  });

  it('lê a seção peers, sem nomes repetidos', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ao-peers-'));
    try {
      const read = peersReader(dir);
      expect(read()).toEqual([]);
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ peers: [{ name: 'a', ssh: 'host-a' }, { name: 'a', ssh: 'outro' }, { name: 'b', ssh: '-x' }, 'lixo'] }));
      expect(read()).toEqual([{ name: 'a', ssh: 'host-a', remotePort: 4747 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dois escritórios: o principal espelha o da outra máquina', () => {
  let other: AgentOfficeApp;
  let main: AgentOfficeApp;
  let peers: PeerConfig[];
  let otherPort: number;
  let mainPort: number;
  let tunnels: { opened: number; closed: number };

  const start = async (): Promise<void> => {
    other = await createApp({ port: 0, dbPath: ':memory:', watch: false });
    otherPort = await other.listen();
    tunnels = { opened: 0, closed: 0 };
    main = await createApp({
      port: 0,
      dbPath: ':memory:',
      watch: false,
      peers: {
        settings: () => peers,
        intervalMs: 30,
        deps: {
          retryMs: 40,
          // no lugar do ssh: um "túnel" que já aponta para o outro escritório
          openTunnel: async () => {
            tunnels.opened++;
            return { port: otherPort, close: () => void tunnels.closed++ };
          },
        },
      },
    });
    mainPort = await main.listen();
  };

  afterEach(async () => {
    await main?.close();
    await other?.close().catch(() => undefined);
  });

  it('sessões, subagentes, atualizações e saídas chegam ao escritório principal', async () => {
    peers = [];
    await start();
    other.store.apply(ev('prompt', 'lá', { meta: { title: 'Migrar autenticação' } }));
    other.store.apply(ev('subagent_start', 'filho', { parentSessionId: 'lá', meta: { agentType: 'Explore' } }));
    main.store.apply(ev('prompt', 'aqui', { cwd: '/Users/ana/site', project: 'site' }));

    peers = [{ name: 'macbook-casa', url: `http://127.0.0.1:${otherPort}`, remotePort: 4747 }];
    const mirrored = await until(() => main.store.get('claude:lá'));
    expect(mirrored).toMatchObject({ machine: 'macbook-casa', status: 'thinking', title: 'Migrar autenticação', project: 'loja', subagents: 1 });
    expect(main.store.get('claude:filho')).toMatchObject({ machine: 'macbook-casa', parentKey: 'claude:lá', agentType: 'Explore' });
    expect(main.store.get('claude:aqui')?.machine).toBeUndefined();
    // a sessão daqui não volta espelhada (o outro escritório não a conhece)
    expect(other.store.has('claude:aqui')).toBe(false);

    // pedido de permissão na outra máquina aparece aqui (e conta para o alerta sonoro)
    other.store.apply(ev('permission_wait', 'lá', { toolName: 'Bash', toolCategory: 'bash' }));
    await until(() => main.store.get('claude:lá')?.status === 'permission_wait');
    expect(main.store.get('claude:lá')).toMatchObject({ toolName: 'Bash', machine: 'macbook-casa' });

    const health = await getJson<HealthResponse>(mainPort, '/api/health');
    expect(health.peers).toEqual([expect.objectContaining({ name: 'macbook-casa', connected: true, sessions: 2, error: null })]);
    // não dá para trazer para a frente uma janela de outra máquina
    expect(await getJson(mainPort, `/api/sessions/${encodeURIComponent('claude:lá')}/focus`, 'POST')).toEqual({
      ok: false,
      detail: 'Esta sessão roda em outra máquina (macbook-casa).',
    });

    other.store.remove('claude:filho');
    await until(() => !main.store.has('claude:filho'));

    // máquina removida da configuração: as sessões dela saem, as daqui ficam
    peers = [];
    await until(() => !main.store.has('claude:lá'));
    expect(main.store.has('claude:aqui')).toBe(true);
    expect((await getJson<HealthResponse>(mainPort, '/api/health')).peers).toEqual([]);
  });

  it('por túnel SSH: sem conexão as sessões saem e voltam quando reconecta', async () => {
    peers = [{ name: 'macbook-casa', ssh: 'ramon@macbook.local', remotePort: 4747 }];
    await start();
    other.store.apply(ev('prompt', 'lá'));
    await until(() => main.store.get('claude:lá'));
    expect(tunnels.opened).toBe(1);

    await other.close();
    await until(() => !main.store.has('claude:lá'));
    const down = await getJson<HealthResponse>(mainPort, '/api/health');
    expect(down.peers[0]).toMatchObject({ name: 'macbook-casa', connected: false, sessions: 0 });
    expect(down.peers[0]?.error).toBeTruthy();
    expect(tunnels.closed).toBeGreaterThanOrEqual(1);

    // a outra máquina volta (em outra porta): o túnel é reaberto e as sessões reaparecem
    other = await createApp({ port: 0, dbPath: ':memory:', watch: false });
    otherPort = await other.listen();
    other.store.apply(ev('prompt', 'de-volta'));
    await until(() => main.store.get('claude:de-volta'), 6000);
    expect(main.store.get('claude:de-volta')?.machine).toBe('macbook-casa');
  });
});
