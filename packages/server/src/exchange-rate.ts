import { EventEmitter } from 'node:events';
import type { Database, Statement } from './db.js';
import type { ExchangeRate } from './pricing.js';
import { isObj, num, str } from './util.js';

/**
 * Câmbio automático do custo em reais: a cotação PTAX de venda do dólar,
 * consultada no Banco Central. Opcional e desligada por padrão — é uma
 * requisição para fora (sem nenhum dado seu: só as datas da consulta).
 * O último valor fica guardado, para valer também sem rede.
 */

/** Intervalo entre consultas: a PTAX sai uma vez por dia útil, por volta das 13h. */
export const RATE_EVERY_MS = 6 * 60 * 60 * 1000;
/** Depois de uma falha, tenta de novo mais cedo. */
const RETRY_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 8000;
const DAY_MS = 24 * 60 * 60 * 1000;
const KEY = 'usdBrlAuto';

export interface Ptax {
  /** Reais por dólar (PTAX de venda). */
  rate: number;
  /** Dia da cotação (AAAA-MM-DD). */
  asOf: string;
}

/** Busca a cotação mais recente (injetável nos testes). */
export type FetchPtax = (now: number) => Promise<Ptax>;

export interface RateStatus {
  enabled: boolean;
  rate: number | null;
  asOf: string | null;
  lastOkAt: number | null;
  error: string | null;
}

/** `MM-DD-AAAA`, como a API do Banco Central espera. */
function bcbDate(ts: number): string {
  const d = new Date(ts);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}-${d.getUTCFullYear()}`;
}

/** Endereço da consulta: os últimos dias (cobre fins de semana e feriados), da mais recente para trás. */
export function ptaxUrl(now: number): string {
  const from = bcbDate(now - 10 * DAY_MS);
  const to = bcbDate(now + DAY_MS);
  return (
    'https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/' +
    'CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)' +
    `?@dataInicial='${from}'&@dataFinalCotacao='${to}'` +
    '&$top=1&$orderby=dataHoraCotacao%20desc&$format=json&$select=cotacaoVenda,dataHoraCotacao'
  );
}

/** Lê a resposta da API: `{ value: [{ cotacaoVenda, dataHoraCotacao }] }`. */
export function parsePtax(raw: unknown): Ptax | null {
  const list = isObj(raw) && Array.isArray(raw.value) ? raw.value : [];
  const first: unknown = list[0];
  if (!isObj(first)) return null;
  const rate = num(first.cotacaoVenda);
  const asOf = str(first.dataHoraCotacao)?.slice(0, 10);
  if (!rate || rate < 0.01 || rate > 1000 || !asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return null;
  return { rate, asOf };
}

export const fetchPtax: FetchPtax = async (now) => {
  const res = await fetch(ptaxUrl(now), { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Banco Central respondeu ${res.status}`);
  const ptax = parsePtax(await res.json());
  if (!ptax) throw new Error('resposta do Banco Central sem cotação');
  return ptax;
};

export class RateWatcher extends EventEmitter<{ change: [] }> {
  private readonly load: Statement;
  private readonly save: Statement;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private stored: (Ptax & { fetchedAt: number }) | null = null;
  private lastTryAt = 0;
  private error: string | null = null;
  private wasEnabled = false;

  constructor(
    db: Database,
    /** Lido a cada passo, para o `agent-office rate auto` valer sem reiniciar. */
    private readonly enabled: () => boolean,
    private readonly fetchRate: FetchPtax = fetchPtax,
    private readonly now: () => number = Date.now,
    private readonly log: (msg: string) => void = () => undefined,
  ) {
    super();
    db.exec('CREATE TABLE IF NOT EXISTS usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.load = db.prepare('SELECT value FROM usage_meta WHERE key = ?');
    this.save = db.prepare('INSERT INTO usage_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    try {
      const saved: unknown = JSON.parse(String(this.load.get(KEY)?.value ?? 'null'));
      if (isObj(saved)) {
        const rate = num(saved.rate);
        const asOf = str(saved.asOf);
        if (rate && asOf) this.stored = { rate, asOf, fetchedAt: num(saved.fetchedAt) ?? 0 };
      }
    } catch {
      /* nada guardado ainda */
    }
  }

  start(intervalMs = 60_000): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** O câmbio automático em uso; undefined quando está desligado ou ainda não há cotação. */
  current(): ExchangeRate | undefined {
    if (!this.enabled() || !this.stored) return undefined;
    return { rate: this.stored.rate, asOf: this.stored.asOf, source: 'bcb' };
  }

  status(): RateStatus {
    const on = this.enabled();
    return {
      enabled: on,
      rate: on ? (this.stored?.rate ?? null) : null,
      asOf: on ? (this.stored?.asOf ?? null) : null,
      lastOkAt: this.stored?.fetchedAt || null,
      error: on ? this.error : null,
    };
  }

  /** Um passo: consulta o Banco Central se estiver ligado e já tiver passado o intervalo. */
  async tick(): Promise<boolean> {
    const on = this.enabled();
    if (on !== this.wasEnabled) {
      this.wasEnabled = on;
      // Ligou agora: consulta já. Desligou: o câmbio volta a ser o manual ou a referência.
      this.lastTryAt = 0;
      this.error = null;
      this.emit('change');
    }
    if (!on || this.busy) return false;
    const now = this.now();
    const fresh = this.stored && now - this.stored.fetchedAt < RATE_EVERY_MS;
    const wait = this.error ? RETRY_MS : RATE_EVERY_MS;
    if ((fresh && !this.error) || (this.lastTryAt > 0 && now - this.lastTryAt < wait)) return false;
    this.busy = true;
    this.lastTryAt = now;
    try {
      const ptax = await this.fetchRate(now);
      const changed = ptax.rate !== this.stored?.rate || ptax.asOf !== this.stored?.asOf;
      this.stored = { ...ptax, fetchedAt: this.now() };
      this.save.run(KEY, JSON.stringify(this.stored));
      if (this.error) this.log('câmbio: consulta ao Banco Central voltou a funcionar');
      this.error = null;
      if (changed) {
        this.log(`câmbio: PTAX de ${ptax.asOf} — US$ 1 = R$ ${ptax.rate}`);
        this.emit('change');
      }
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      if (message !== this.error) this.log(`câmbio: ${message}`);
      this.error = message;
    } finally {
      this.busy = false;
    }
    return true;
  }
}
