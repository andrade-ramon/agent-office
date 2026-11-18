import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AgentOfficeApp } from '../src/app.js';
import { HistoryDb } from '../src/db.js';
import { RATE_EVERY_MS, RateWatcher, parsePtax, ptaxUrl, type Ptax } from '../src/exchange-rate.js';
import type { HealthResponse, UsageResponse } from '../src/schema.js';

const NOON = Date.UTC(2026, 10, 18, 15, 0, 0);

describe('cotação PTAX do Banco Central', () => {
  it('monta a consulta sem nenhum dado além das datas', () => {
    const url = new URL(ptaxUrl(NOON));
    expect(url.origin).toBe('https://olinda.bcb.gov.br');
    expect(url.pathname).toContain('/PTAX/versao/v1/odata/CotacaoDolarPeriodo');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      '@dataInicial': "'11-08-2026'",
      '@dataFinalCotacao': "'11-19-2026'",
      $top: '1',
      $orderby: 'dataHoraCotacao desc',
      $format: 'json',
      $select: 'cotacaoVenda,dataHoraCotacao',
    });
  });

  it('lê a resposta da API e recusa o que não é uma cotação', () => {
    const body = { value: [{ cotacaoCompra: 5.7845, cotacaoVenda: 5.7851, dataHoraCotacao: '2026-11-17 13:07:26.01516' }] };
    expect(parsePtax(body)).toEqual({ rate: 5.7851, asOf: '2026-11-17' });
    expect(parsePtax({ value: [] })).toBeNull();
    expect(parsePtax({ value: [{ cotacaoVenda: 0, dataHoraCotacao: '2026-11-17 13:07:26' }] })).toBeNull();
    expect(parsePtax({ value: [{ cotacaoVenda: '5,78', dataHoraCotacao: '2026-11-17 13:07:26' }] })).toBeNull();
    expect(parsePtax({ value: [{ cotacaoVenda: 5.78, dataHoraCotacao: 'ontem' }] })).toBeNull();
    expect(parsePtax('<html>fora do ar</html>')).toBeNull();
  });
});

describe('câmbio automático', () => {
  let db: HistoryDb;
  let now: number;
  let enabled: boolean;
  let calls: number;
  let answer: Ptax | Error;
  const fetchRate = async (): Promise<Ptax> => {
    calls++;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const watcher = (): RateWatcher => new RateWatcher(db.handle, () => enabled, fetchRate, () => now);

  beforeEach(async () => {
    db = await HistoryDb.open(':memory:');
    now = NOON;
    enabled = true;
    calls = 0;
    answer = { rate: 5.7851, asOf: '2026-11-17' };
  });
  afterEach(() => db.close());

  it('desligado, não consulta nada', async () => {
    enabled = false;
    const w = watcher();
    expect(await w.tick()).toBe(false);
    expect(calls).toBe(0);
    expect(w.current()).toBeUndefined();
    expect(w.status()).toEqual({ enabled: false, rate: null, asOf: null, lastOkAt: null, error: null });
  });

  it('ligado, busca a cotação e só volta a consultar depois do intervalo', async () => {
    const w = watcher();
    let changes = 0;
    w.on('change', () => changes++);
    expect(await w.tick()).toBe(true);
    expect(w.current()).toEqual({ rate: 5.7851, asOf: '2026-11-17', source: 'bcb' });
    expect(w.status()).toMatchObject({ enabled: true, rate: 5.7851, asOf: '2026-11-17', lastOkAt: NOON, error: null });
    const afterFirst = changes;

    now += RATE_EVERY_MS - 60_000;
    expect(await w.tick()).toBe(false);
    expect(calls).toBe(1);

    // Mesma cotação de novo (fim de semana): consulta, mas não avisa ninguém.
    now += 120_000;
    expect(await w.tick()).toBe(true);
    expect(calls).toBe(2);
    expect(changes).toBe(afterFirst);

    answer = { rate: 5.81, asOf: '2026-11-18' };
    now += RATE_EVERY_MS;
    await w.tick();
    expect(w.current()).toMatchObject({ rate: 5.81, asOf: '2026-11-18' });
    expect(changes).toBe(afterFirst + 1);
  });

  it('sem rede, mantém a última cotação e tenta de novo em 15 minutos', async () => {
    const w = watcher();
    await w.tick();
    answer = new Error('fetch failed');
    now += RATE_EVERY_MS + 1;
    await w.tick();
    expect(w.current()).toMatchObject({ rate: 5.7851 });
    expect(w.status()).toMatchObject({ rate: 5.7851, error: 'fetch failed' });

    now += 5 * 60_000;
    expect(await w.tick()).toBe(false);
    answer = { rate: 5.9, asOf: '2026-11-18' };
    now += 11 * 60_000;
    expect(await w.tick()).toBe(true);
    expect(w.status()).toMatchObject({ rate: 5.9, error: null });
    expect(calls).toBe(3);
  });

  it('a cotação guardada vale depois de reiniciar, sem consultar de novo', async () => {
    await watcher().tick();
    now += 60 * 60_000;
    const again = watcher();
    expect(again.current()).toEqual({ rate: 5.7851, asOf: '2026-11-17', source: 'bcb' });
    expect(await again.tick()).toBe(false);
    expect(calls).toBe(1);
  });

  it('desligar volta ao câmbio manual ou à referência; religar consulta na hora', async () => {
    const w = watcher();
    await w.tick();
    enabled = false;
    await w.tick();
    expect(w.current()).toBeUndefined();
    expect(calls).toBe(1);

    enabled = true;
    now += RATE_EVERY_MS + 1;
    await w.tick();
    expect(calls).toBe(2);
    expect(w.current()).toMatchObject({ source: 'bcb' });
  });
});

describe('câmbio no painel de dados', () => {
  let app: AgentOfficeApp | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const cost = async (port: number): Promise<UsageResponse['cost']> =>
    ((await (await fetch(`http://127.0.0.1:${port}/api/usage`)).json()) as UsageResponse).cost;

  it('automático tem prioridade sobre o valor digitado, que tem prioridade sobre a referência', async () => {
    let auto = false;
    const config: { usdBrl?: number } = {};
    let fetched = 0;
    app = await createApp({
      port: 0,
      dbPath: ':memory:',
      watch: false,
      usage: {
        usdBrl: () => config.usdBrl,
        autoRate: {
          enabled: () => auto,
          fetch: async () => {
            fetched++;
            return { rate: 5.9, asOf: '2026-11-18' };
          },
          intervalMs: 20,
        },
      },
    });
    const port = await app.listen();
    expect(await cost(port)).toMatchObject({ usdBrlSource: 'embedded', usdBrlAsOf: '2026-11-17' });
    expect(fetched).toBe(0);

    config.usdBrl = 5.43;
    expect(await cost(port)).toMatchObject({ usdBrl: 5.43, usdBrlAsOf: null, usdBrlSource: 'config' });

    auto = true;
    await expect.poll(() => cost(port), { timeout: 3000 }).toMatchObject({ usdBrl: 5.9, usdBrlAsOf: '2026-11-18', usdBrlSource: 'bcb' });
    const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as HealthResponse;
    expect(health.exchange).toMatchObject({ enabled: true, rate: 5.9, asOf: '2026-11-18', error: null });

    auto = false;
    await expect.poll(() => cost(port), { timeout: 3000 }).toMatchObject({ usdBrl: 5.43, usdBrlSource: 'config' });
  });

  it('o modo demo nunca consulta o Banco Central', async () => {
    let fetched = 0;
    app = await createApp({
      port: 0,
      dbPath: ':memory:',
      watch: false,
      demo: { concurrency: 0 },
      usage: {
        autoRate: {
          enabled: () => true,
          fetch: async () => {
            fetched++;
            return { rate: 9, asOf: '2026-11-18' };
          },
          intervalMs: 10,
        },
      },
    });
    const port = await app.listen();
    await new Promise((r) => setTimeout(r, 80));
    expect(fetched).toBe(0);
    expect(await cost(port)).toMatchObject({ usdBrlSource: 'embedded' });
  });
});
