import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createApp, type AgentOfficeApp } from '../src/app.js';
import { HistoryDb } from '../src/db.js';
import { ClaudeTranscriptParser } from '../src/normalize/claude.js';
import { CodexRolloutParser } from '../src/normalize/codex.js';
import type { ServerMessage, UsageResponse } from '../src/schema.js';
import { ACTIVE_GAP_MS, UsageLedger, type TranscriptFile } from '../src/usage.js';

const SID = '11111111-2222-3333-4444-555555555555';
const CODEX_ID = '01a1d277-ce8c-70f0-8553-f45aa93772ef';
/** Um dia fixo, no fuso local (os contadores são por dia local). */
const DAY = new Date(2026, 10, 10).getTime();
const at = (h: number, m = 0, s = 0): string => new Date(DAY + ((h * 60 + m) * 60 + s) * 1000).toISOString();
const jsonl = (o: unknown): string => `${JSON.stringify(o)}\n`;

let seq = 0;
const uuid = (): string => `uuid-${++seq}`;

interface Usage {
  in: number;
  out: number;
  read: number;
  write: number;
}

function prompt(ts: string, id = uuid(), sessionId = SID): string {
  return jsonl({ type: 'user', uuid: id, sessionId, cwd: '/Users/ana/github/loja', timestamp: ts, message: { role: 'user', content: 'oi' } });
}

function assistant(ts: string, messageId: string, u: Usage, opts: { tool?: string; end?: boolean; id?: string } = {}): string {
  return jsonl({
    type: 'assistant',
    uuid: opts.id ?? uuid(),
    sessionId: SID,
    cwd: '/Users/ana/github/loja',
    timestamp: ts,
    message: {
      id: messageId,
      role: 'assistant',
      model: 'claude-fable-5-2',
      stop_reason: opts.end ? 'end_turn' : opts.tool ? 'tool_use' : null,
      usage: { input_tokens: u.in, output_tokens: u.out, cache_read_input_tokens: u.read, cache_creation_input_tokens: u.write },
      content: opts.tool ? [{ type: 'tool_use', id: opts.tool, name: 'Bash', input: {} }] : [{ type: 'text', text: 'ok' }],
    },
  });
}

function toolResult(ts: string, tool: string, id = uuid()): string {
  return jsonl({
    type: 'user',
    uuid: id,
    sessionId: SID,
    cwd: '/Users/ana/github/loja',
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, content: 'ok' }] },
  });
}

/** Um turno com ferramenta e uma pausa longa, depois outro turno curto. */
function session(): string[] {
  return [
    prompt(at(10, 0, 0), 'p1'),
    // A mesma resposta em duas linhas: a segunda traz a contagem final.
    assistant(at(10, 0, 10), 'msg_1', { in: 100, out: 5, read: 1000, write: 50 }, { id: 'a1' }),
    assistant(at(10, 0, 12), 'msg_1', { in: 100, out: 40, read: 1000, write: 50 }, { tool: 't1', id: 'a2' }),
    toolResult(at(10, 0, 30), 't1', 'r1'),
    assistant(at(10, 10, 30), 'msg_2', { in: 10, out: 20, read: 2000, write: 0 }, { end: true, id: 'a3' }),
    prompt(at(11, 0, 0), 'p2'),
    assistant(at(11, 0, 20), 'msg_3', { in: 1, out: 1, read: 1, write: 1 }, { end: true, id: 'a4' }),
  ];
}

describe('painel de dados: livro-razão de uso', () => {
  let tmp: string;
  let db: HistoryDb;
  let ledger: UsageLedger;
  const now = DAY + 12 * 3_600_000;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'agent-office-usage-'));
    db = await HistoryDb.open(':memory:');
    ledger = new UsageLedger(db.handle, { now: () => now });
  });

  afterEach(async () => {
    await ledger.stop();
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const claudeFile = (name: string, subagentId?: string): TranscriptFile => ({
    agent: 'claude',
    path: join(tmp, name),
    sessionId: SID,
    ...(subagentId ? { subagentId } : {}),
  });

  it('soma tokens, prompts, ferramentas e tempo ativo de um transcript do Claude', async () => {
    const file = claudeFile('a.jsonl');
    writeFileSync(file.path, session().join(''));
    await ledger.scan(file);

    const s = ledger.summary();
    expect(s.allTime.tokens).toEqual({ input: 111, output: 61, cacheRead: 3001, cacheWrite: 51, total: 3224 });
    expect(s.allTime).toMatchObject({ prompts: 2, tools: 1, errors: 0, sessions: 1, subagents: 0 });
    // 10 s + 2 s + 18 s, a pausa de 10 min conta só o teto, e mais 20 s do segundo turno.
    expect(s.allTime.activeMs).toBe(30_000 + ACTIVE_GAP_MS + 20_000);
    expect(s.toolsByCategory.bash).toBe(1);
    // Fable 5.2: entrada US$ 8, saída US$ 40, cache lido US$ 0,20 e gravado (5 min) US$ 10 por milhão.
    const usd = (111 * 8 + 61 * 40 + 3001 * 0.2 + 51 * 10) / 1e6;
    expect(s.models).toEqual([{ name: 'claude-fable-5-2', tokens: 3224, costUsd: Math.round(usd * 100) / 100 }]);
    expect(s.projects).toEqual([{ name: 'loja', tokens: 3224 }]);
    expect(s.byAgent.claude.tokens.total).toBe(3224);
    expect(s.byAgent.codex.tokens.total).toBe(0);
    expect(s.today.prompts).toBe(2);
    expect(s.since).toBe(DAY);
    expect(s.busiestDay).toEqual({ day: DAY, tokens: 3224 });
  });

  it('lê só o que é novo e nunca conta duas vezes', async () => {
    const file = claudeFile('a.jsonl');
    const lines = session();
    writeFileSync(file.path, lines.slice(0, 3).join(''));
    await ledger.scan(file);
    expect(ledger.summary().allTime).toMatchObject({ prompts: 1, tools: 1 });
    expect(ledger.summary().allTime.tokens.output).toBe(40);

    // Uma linha pela metade ainda não conta.
    const rest = lines.slice(3).join('');
    appendFileSync(file.path, rest.slice(0, rest.length - 40));
    await ledger.scan(file);
    expect(ledger.summary().allTime.prompts).toBe(2);
    expect(ledger.summary().allTime.tokens.total).toBe(3220);

    appendFileSync(file.path, rest.slice(rest.length - 40));
    await ledger.scan(file);
    await ledger.scan(file);
    expect(ledger.summary().allTime.tokens.total).toBe(3224);
    expect(ledger.summary().allTime.activeMs).toBe(30_000 + ACTIVE_GAP_MS + 20_000);

    // Outro livro-razão sobre o mesmo banco (reinício do servidor) continua de onde parou.
    const again = new UsageLedger(db.handle, { now: () => now });
    await again.scan(file);
    expect(again.summary().allTime).toMatchObject({ prompts: 2, tools: 1, sessions: 1 });
    expect(again.summary().allTime.tokens.total).toBe(3224);
    await again.stop();
  });

  it('não reconta o histórico copiado para outro arquivo (sessão retomada ou bifurcada)', async () => {
    const original = claudeFile('a.jsonl');
    writeFileSync(original.path, session().join(''));
    await ledger.scan(original);

    // Cópia pura: nenhuma atividade nova, nem conta como sessão.
    const copy = claudeFile('b.jsonl');
    writeFileSync(copy.path, session().join(''));
    await ledger.scan(copy);
    expect(ledger.summary().allTime).toMatchObject({ prompts: 2, sessions: 1 });
    expect(ledger.summary().allTime.tokens.total).toBe(3224);

    // Cópia que segue em frente: só o trecho novo entra.
    const fork = claudeFile('c.jsonl');
    writeFileSync(
      fork.path,
      session().join('') +
        // a mesma resposta regravada com outro uuid de linha
        assistant(at(11, 0, 21), 'msg_3', { in: 1, out: 1, read: 1, write: 1 }, { end: true }) +
        prompt(at(12, 0, 0)) +
        assistant(at(12, 0, 5), 'msg_4', { in: 2, out: 3, read: 4, write: 5 }, { end: true }),
    );
    await ledger.scan(fork);
    const s = ledger.summary();
    expect(s.allTime).toMatchObject({ prompts: 3, sessions: 2 });
    expect(s.allTime.tokens.total).toBe(3224 + 14);
  });

  it('conta subagentes à parte das sessões principais', async () => {
    const file = claudeFile('agent-abc.jsonl', 'abc');
    writeFileSync(
      file.path,
      // No transcript do subagente a tarefa chega como uma mensagem do usuário: não é um prompt seu.
      prompt(at(9, 0, 0)) +
        assistant(at(9, 0, 4), 'msg_s1', { in: 5, out: 5, read: 0, write: 0 }, { tool: 's1' }) +
        toolResult(at(9, 0, 10), 's1') +
        assistant(at(9, 0, 14), 'msg_s2', { in: 1, out: 1, read: 0, write: 0 }, { end: true }),
    );
    await ledger.scan(file);
    const s = ledger.summary().allTime;
    expect(s).toMatchObject({ prompts: 0, tools: 1, sessions: 0, subagents: 1, activeMs: 0 });
    expect(s.subagentActiveMs).toBe(10_000);
    expect(s.tokens.total).toBe(12);
  });

  it('usa o acumulado do Codex e não reconta a sessão quando ela é arquivada', async () => {
    const rec = (ts: string, type: string, payload: unknown): string => jsonl({ timestamp: ts, type, payload });
    const count = (ts: string, input: number, cached: number, output: number): string =>
      rec(ts, 'event_msg', {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output },
          last_token_usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
    const name = `rollout-2026-11-10T10-00-00-${CODEX_ID}.jsonl`;
    const live = join(tmp, 'sessions', name);
    mkdirSync(join(tmp, 'sessions'));
    mkdirSync(join(tmp, 'archived'));
    writeFileSync(
      live,
      rec(at(10), 'session_meta', { id: CODEX_ID, cwd: '/repo/api', originator: 'codex_cli' }) +
        rec(at(10, 0, 1), 'turn_context', { cwd: '/repo/api', model: 'gpt-5-codex' }) +
        rec(at(10, 0, 1), 'event_msg', { type: 'task_started' }) +
        rec(at(10, 0, 5), 'response_item', { type: 'function_call', name: 'shell', call_id: 'c1' }) +
        rec(at(10, 0, 9), 'response_item', { type: 'function_call_output', call_id: 'c1' }) +
        count(at(10, 0, 10), 1000, 800, 50) +
        // o Codex repete o mesmo acumulado: não soma de novo
        count(at(10, 0, 11), 1000, 800, 50) +
        count(at(10, 0, 20), 2500, 2000, 120) +
        rec(at(10, 0, 21), 'event_msg', { type: 'task_complete' }),
    );
    await ledger.touchCodexDir(join(tmp, 'sessions'));
    await ledger.idle();

    const check = (): void => {
      const s = ledger.summary();
      expect(s.byAgent.codex.tokens).toEqual({ input: 500, output: 120, cacheRead: 2000, cacheWrite: 0, total: 2620 });
      expect(s.byAgent.codex).toMatchObject({ prompts: 1, tools: 1, sessions: 1, activeMs: 20_000 });
      expect(s.models).toMatchObject([{ name: 'gpt-5-codex', tokens: 2620 }]);
      expect(s.projects).toEqual([{ name: 'api', tokens: 2620 }]);
    };
    check();

    renameSync(live, join(tmp, 'archived', name));
    await ledger.touchCodexDir(join(tmp, 'archived'));
    await ledger.idle();
    check();
  });

  it('separa hoje, os últimos 7 dias e o gráfico de 14 dias', () => {
    const dayAgo = (n: number): number => new Date(2026, 10, 10 - n, 9).getTime();
    ledger.record('claude', dayAgo(0), 'in', 10);
    ledger.record('codex', dayAgo(0), 'out', 5);
    ledger.record('claude', dayAgo(0), 'prompts', 2);
    ledger.record('claude', dayAgo(3), 'cr', 100);
    ledger.record('claude', dayAgo(3), 'active', 60_000);
    ledger.record('claude', dayAgo(10), 'cw', 1000);
    ledger.record('claude', dayAgo(40), 'in', 10_000);
    ledger.record('claude', dayAgo(40), 'model:antigo|in', 10_000);
    ledger.record('claude', dayAgo(0), 'model:novo|out', 15);

    const s = ledger.summary();
    expect(s.today.tokens.total).toBe(15);
    expect(s.today.prompts).toBe(2);
    expect(s.week.tokens.total).toBe(115);
    expect(s.week.activeMs).toBe(60_000);
    expect(s.allTime.tokens.total).toBe(11_115);
    expect(s.days).toHaveLength(14);
    expect(s.days.at(-1)).toMatchObject({ day: DAY, claude: 10, codex: 5, prompts: 2 });
    expect(s.days.at(-4)).toMatchObject({ claude: 100, activeMs: 60_000 });
    expect(s.days.at(-11)).toMatchObject({ claude: 1000 });
    expect(s.days.reduce((sum, d) => sum + d.claude + d.codex, 0)).toBe(1115);
    expect(s.activeDays).toBe(4);
    expect(s.since).toBe(new Date(2026, 10, 10 - 40).getTime());
    expect(s.busiestDay?.tokens).toBe(10_000);
    expect(s.models.map((m) => m.name)).toEqual(['antigo', 'novo']);
    expect(s.scan).toEqual({ pending: 0, done: 0, scanning: false });
  });

  it('estima o custo pelo preço de tabela de cada modelo, tipo de token e modo', async () => {
    const reply = (id: string, model: string, usage: Record<string, unknown>): string =>
      jsonl({
        type: 'assistant',
        uuid: uuid(),
        sessionId: SID,
        cwd: '/Users/ana/github/loja',
        timestamp: at(10),
        message: { id, role: 'assistant', model, stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'ok' }] },
      });
    const file = claudeFile('custo.jsonl');
    writeFileSync(
      file.path,
      prompt(at(9, 59)) +
        // Fable 5.2: 1 mi de entrada (8) + 100 mil de saída (4) + 10 mi de cache lido (2)
        // + 500 mil gravados por 5 min (5) + 1,5 mi gravados por 1 h (24) = US$ 43
        reply('m1', 'claude-fable-5-2', {
          input_tokens: 1_000_000,
          output_tokens: 100_000,
          cache_read_input_tokens: 10_000_000,
          cache_creation_input_tokens: 2_000_000,
          cache_creation: { ephemeral_5m_input_tokens: 500_000, ephemeral_1h_input_tokens: 1_500_000 },
        }) +
        // Opus 5 em modo rápido custa o dobro: 1 mi de entrada (10) + 1 mi de saída (50) = US$ 60
        reply('m2', 'claude-opus-5', { input_tokens: 1_000_000, output_tokens: 1_000_000, speed: 'fast' }) +
        // Haiku 5.5 com prompt acima de 100 mil tokens: 200 mil de cache lido a 0,05 = US$ 0,01
        reply('m3', 'claude-haiku-5-5', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 200_000 }) +
        // ...e abaixo do limite: 1 mi de saída a 0,50 = US$ 0,50
        reply('m4', 'claude-haiku-5-5', { input_tokens: 10, output_tokens: 1_000_000 }) +
        // Modelo fora da tabela: entra nos tokens, não no custo.
        reply('m5', 'modelo-novo-9', { input_tokens: 3_000_000, output_tokens: 0 }),
    );
    await ledger.scan(file);

    const s = ledger.summary();
    expect(s.allTime.costUsd).toBe(103.51);
    expect(s.today.costUsd).toBe(103.51);
    expect(s.byAgent.claude.costUsd).toBe(103.51);
    expect(s.byAgent.codex.costUsd).toBe(0);
    expect(Object.fromEntries(s.models.map((m) => [m.name, m.costUsd]))).toEqual({
      'claude-fable-5-2': 43,
      'claude-opus-5': 60,
      'claude-haiku-5-5': 0.51,
      'modelo-novo-9': 0,
    });
    expect(s.cost).toMatchObject({ unpricedTokens: 3_000_000, unpriced: [{ name: 'modelo-novo-9', tokens: 3_000_000 }] });
    expect(s.cost.pricesAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Com o preço do modelo novo no config.json, ele entra na conta sem reler nada.
    let prices = {};
    const priced = new UsageLedger(db.handle, { now: () => now, prices: () => prices });
    expect(priced.summary().allTime.costUsd).toBe(103.51);
    prices = { 'modelo-novo-9': { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 } };
    expect(priced.summary().allTime.costUsd).toBe(106.51);
    expect(priced.summary().cost.unpricedTokens).toBe(0);
    await priced.stop();
  });

  it('relê tudo quando o formato dos contadores muda', async () => {
    const file = claudeFile('a.jsonl');
    writeFileSync(file.path, session().join(''));
    await ledger.scan(file);
    expect(ledger.summary().allTime.prompts).toBe(2);

    // Banco gravado por uma versão anterior.
    db.handle.exec("UPDATE usage_meta SET value = '1' WHERE key = 'format'");
    const upgraded = new UsageLedger(db.handle, { now: () => now });
    expect(upgraded.summary().allTime.prompts).toBe(0);
    await upgraded.scan(file);
    expect(upgraded.summary().allTime).toMatchObject({ prompts: 2, sessions: 1 });
    expect(upgraded.summary().allTime.tokens.total).toBe(3224);

    // No formato atual, nada é descartado ao reabrir.
    const reopened = new UsageLedger(db.handle, { now: () => now });
    expect(reopened.summary().allTime.prompts).toBe(2);
    await upgraded.stop();
    await reopened.stop();
  });

  it('os parsers informam o consumo sem carregar conteúdo', () => {
    const claude = new ClaudeTranscriptParser({ sessionId: SID });
    const [meta] = claude.parse(JSON.parse(assistant(at(10), 'msg_9', { in: 3, out: 4, read: 5, write: 6 })));
    expect(meta).toMatchObject({
      kind: 'meta',
      meta: { contextTokens: 14, messageId: 'msg_9', usage: { input: 3, output: 4, cacheRead: 5, cacheWrite: 6 } },
    });

    const codex = new CodexRolloutParser(CODEX_ID);
    const [total] = codex.parse({
      timestamp: at(10),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 70, cache_write_input_tokens: 10, output_tokens: 9 } },
      },
    });
    expect(total).toMatchObject({ kind: 'meta', meta: { usageTotal: { input: 20, output: 9, cacheRead: 70, cacheWrite: 10 } } });
  });
});

describe('painel de dados: do transcript ao navegador', () => {
  let app: AgentOfficeApp | undefined;
  let tmp: string | undefined;
  let ws: WebSocket | undefined;

  afterEach(async () => {
    ws?.close();
    await app?.close();
    app = undefined;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('expõe /api/usage e avisa os clientes pelo WebSocket quando os números mudam', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'agent-office-usage-'));
    const claudeDir = join(tmp, 'claude', 'projects');
    const project = join(claudeDir, '-Users-ana-loja');
    mkdirSync(project, { recursive: true });
    // Sessão antiga, de antes de o servidor subir: o watcher ao vivo a ignora, o painel não.
    writeFileSync(join(project, `${SID}.jsonl`), session().join(''));

    app = await createApp({
      port: 0,
      dbPath: ':memory:',
      version: 'test',
      watch: { claudeDir, codexDir: false, claudeSessionsDir: false, usePolling: true },
    });
    const port = await app.listen();
    await app.usage.idle();

    const res = await fetch(`http://127.0.0.1:${port}/api/usage`);
    const usage = (await res.json()) as UsageResponse;
    expect(usage.allTime).toMatchObject({ prompts: 2, tools: 1, sessions: 1 });
    expect(usage.allTime.tokens.total).toBe(3224);

    const pushed = new Promise<UsageResponse>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('nenhum aviso de uso chegou')), 8000);
      ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as ServerMessage;
        if (msg.type === 'hello') {
          // Uma sessão nova começa a escrever depois de o cliente conectar.
          const live = join(project, '99999999-2222-3333-4444-555555555555.jsonl');
          const ts = new Date().toISOString();
          writeFileSync(live, prompt(ts, undefined, '99999999-2222-3333-4444-555555555555') + assistant(ts, 'msg_live', { in: 6, out: 0, read: 0, write: 0 }, { end: true }));
        } else if (msg.type === 'usage' && msg.usage.allTime.prompts === 3) {
          clearTimeout(timer);
          resolve(msg.usage);
        }
      });
      ws.on('error', reject);
    });
    const live = await pushed;
    expect(live.allTime.tokens.total).toBe(3230);
    expect(live.allTime.sessions).toBe(2);
  });
});
