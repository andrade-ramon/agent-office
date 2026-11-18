import type { TokenUsage } from './schema.js';

/**
 * Preços de tabela das APIs, em dólares por milhão de tokens, para estimar o
 * custo no painel de dados. É uma estimativa: quem usa os agentes por
 * assinatura não paga por token, e descontos ou outros provedores (Bedrock,
 * Vertex) têm preços próprios.
 *
 * A tabela fica no código porque o agent-office não faz requisições para fora.
 * Fontes, conferidas em PRICES_AS_OF:
 *   https://platform.claude.com/docs/en/about-claude/pricing
 *   https://developers.openai.com/api/docs/pricing
 * Modelos novos ou preços diferentes entram pela seção "prices" do config.json.
 */
export const PRICES_AS_OF = '2026-11-18';

/**
 * Câmbio de referência para mostrar o custo em reais: PTAX de venda do Banco
 * Central no dia indicado. Fica fixo no código (nada é consultado fora da
 * máquina); o valor do dia entra por `agent-office rate <valor>`.
 */
export const USD_BRL = { rate: 5.7851, asOf: '2026-11-17' } as const;

/** Valida o câmbio do config.json ("usdBrl"): reais por dólar. */
export function parseUsdBrl(raw: unknown): number | undefined {
  const v = typeof raw === 'string' ? Number(raw.replace(',', '.')) : raw;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0.01 && v <= 1000 ? v : undefined;
}

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  /** Gravação no cache padrão (5 minutos no Claude). */
  cacheWrite: number;
  /** Gravação no cache de 1 hora. */
  cacheWrite1h: number;
}

/** Como um contador de tokens por modelo é cobrado. */
export type PriceKind = 'in' | 'out' | 'cr' | 'cw' | 'cw1h';
export const PRICE_KINDS: readonly PriceKind[] = ['in', 'out', 'cr', 'cw', 'cw1h'];

/** Claude: gravar no cache custa 1,25× (5 min) ou 2× (1 h) a entrada. */
function claude(input: number, output: number, cacheRead: number): ModelPrice {
  return { input, output, cacheRead, cacheWrite: input * 1.25, cacheWrite1h: input * 2 };
}

/** OpenAI: entrada, entrada em cache e saída; gravação no cache quando a tabela informa. */
function openai(input: number, cached: number | null, output: number, cacheWrite?: number): ModelPrice {
  return { input, output, cacheRead: cached ?? input, cacheWrite: cacheWrite ?? input, cacheWrite1h: cacheWrite ?? input };
}

const TABLE: Record<string, ModelPrice> = {
  // ── Anthropic ──
  'claude-fable-5-2': claude(8, 40, 0.2),
  'claude-mythos-5-2': claude(8, 40, 0.2),
  'claude-fable-5-1': claude(10, 50, 0.25),
  'claude-mythos-5-1': claude(10, 50, 0.25),
  'claude-fable-5': claude(10, 50, 1),
  'claude-mythos-5': claude(10, 50, 1),
  'claude-opus-5-5': claude(4, 20, 0.2),
  'claude-opus-5': claude(5, 25, 0.5),
  'claude-opus-4-8': claude(5, 25, 0.5),
  'claude-opus-4-7': claude(5, 25, 0.5),
  'claude-opus-4-6': claude(5, 25, 0.5),
  'claude-opus-4-5': claude(5, 25, 0.5),
  'claude-opus-4-1': claude(15, 75, 1.5),
  'claude-opus-4': claude(15, 75, 1.5),
  'claude-sonnet-5-5': claude(2, 10, 0.1),
  'claude-sonnet-5': claude(2, 10, 0.2),
  'claude-sonnet-4-6': claude(3, 15, 0.3),
  'claude-sonnet-4-5': claude(3, 15, 0.3),
  'claude-sonnet-4': claude(3, 15, 0.3),
  'claude-haiku-5-5': claude(0.1, 0.5, 0.01),
  'claude-haiku-4-5': claude(1, 5, 0.1),
  // ── OpenAI (Standard, contexto curto) ──
  'gpt-6.2-astra': openai(8, 0.4, 40, 10),
  'gpt-6.2-sol': openai(2, 0.1, 10, 2.5),
  'gpt-6-astra': openai(10, 1, 50, 12.5),
  'gpt-6.1-sol': openai(2, 0.1, 10, 2.5),
  'gpt-6.1-terra': openai(1, 0.05, 5, 1.25),
  'gpt-6-luna': openai(0.1, 0.01, 0.5, 0.125),
  'gpt-6-sol': openai(2, 0.2, 10, 2.5),
  'gpt-5.6-sol': openai(4, 0.4, 20, 5),
  'gpt-5.6-terra': openai(2, 0.2, 12, 2.5),
  'gpt-5.6-luna': openai(0.2, 0.02, 1.2, 0.25),
  'gpt-5.5': openai(5, 0.5, 30),
  'gpt-5.5-pro': openai(30, null, 180),
  'gpt-5.4': openai(2.5, 0.25, 15),
  'gpt-5.4-pro': openai(30, null, 180),
  'gpt-5.4-mini': openai(0.75, 0.075, 4.5),
  'gpt-5.4-nano': openai(0.2, 0.02, 1.25),
  'gpt-5.3-codex': openai(1.75, 0.175, 14),
  'gpt-5.2': openai(1.75, 0.175, 14),
  'gpt-5.2-pro': openai(21, null, 168),
  'gpt-5.1': openai(1.25, 0.125, 10),
  'gpt-5': openai(1.25, 0.125, 10),
  'gpt-5-mini': openai(0.25, 0.025, 2),
  'gpt-5-nano': openai(0.05, 0.005, 0.4),
  'gpt-5-pro': openai(15, null, 120),
};

/** Modo rápido (`speed: "fast"`): o dobro em todas as categorias, onde existe. */
const FAST: Record<string, number> = {
  'claude-fable-5-2': 2,
  'claude-mythos-5-2': 2,
  'claude-opus-5-5': 2,
  'claude-opus-5': 2,
  'claude-opus-4-8': 2,
};

/** Claude Haiku 5.5: requisições com mais de 100 mil tokens de prompt custam 5×. */
const LONG: Record<string, { over: number; factor: number }> = {
  'claude-haiku-5-5': { over: 100_000, factor: 5 },
};

/** Sufixos que não mudam o preço: data da versão, apelidos e variantes do Codex. */
const SUFFIX = /^-(\d{8}|latest|codex.*|preview.*)$/;

export type PriceOverrides = Readonly<Record<string, ModelPrice>>;
const NO_OVERRIDES: PriceOverrides = {};

function positive(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Valida a seção "prices" do config.json: `{ "modelo": { input, output, cacheRead?, cacheWrite?, cacheWrite1h? } }`. */
export function parsePrices(raw: unknown): PriceOverrides {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return NO_OVERRIDES;
  const out: Record<string, ModelPrice> = {};
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const o = value as Record<string, unknown>;
    const input = positive(o.input);
    const output = positive(o.output);
    if (input === undefined || output === undefined) continue;
    out[model] = {
      input,
      output,
      cacheRead: positive(o.cacheRead) ?? input * 0.1,
      cacheWrite: positive(o.cacheWrite) ?? input * 1.25,
      cacheWrite1h: positive(o.cacheWrite1h) ?? positive(o.cacheWrite) ?? input * 2,
    };
  }
  return Object.keys(out).length > 0 ? out : NO_OVERRIDES;
}

/** Nome do modelo na tabela: o próprio id ou o id sem um sufixo que não muda o preço. */
function baseModel(model: string, table: Readonly<Record<string, ModelPrice>>): string | null {
  if (model in table) return model;
  let best: string | null = null;
  for (const name of Object.keys(table)) {
    if (!model.startsWith(name) || !SUFFIX.test(model.slice(name.length))) continue;
    if (!best || name.length > best.length) best = name;
  }
  return best;
}

/**
 * Como uma resposta é cobrada além do modelo: "+fast" (modo rápido) ou
 * "+long" (prompt acima do limite em que o preço muda). Decidido na leitura do
 * transcript, porque depende de cada requisição.
 */
export function priceVariant(model: string, usage: TokenUsage, fast: boolean): '' | '+fast' | '+long' {
  const base = baseModel(model, TABLE) ?? model;
  if (fast && FAST[base]) return '+fast';
  const long = LONG[base];
  if (long && usage.input + usage.cacheRead + usage.cacheWrite > long.over) return '+long';
  return '';
}

/** Separa "claude-opus-5+fast" em modelo e variante. */
export function splitPriceKey(key: string): { model: string; variant: string } {
  const cut = key.lastIndexOf('+');
  return cut > 0 ? { model: key.slice(0, cut), variant: key.slice(cut) } : { model: key, variant: '' };
}

/** Preço de um modelo (com a variante); null quando ele não está na tabela nem no config. */
export function priceOf(key: string, overrides: PriceOverrides = NO_OVERRIDES): ModelPrice | null {
  const { model, variant } = splitPriceKey(key);
  const custom = baseModel(model, overrides);
  const base = custom ? null : baseModel(model, TABLE);
  const price = custom ? overrides[custom]! : base ? TABLE[base]! : null;
  if (!price) return null;
  const name = custom ?? base!;
  const factor = variant === '+fast' ? (FAST[name] ?? 1) : variant === '+long' ? (LONG[name]?.factor ?? 1) : 1;
  if (factor === 1) return price;
  return {
    input: price.input * factor,
    output: price.output * factor,
    cacheRead: price.cacheRead * factor,
    cacheWrite: price.cacheWrite * factor,
    cacheWrite1h: price.cacheWrite1h * factor,
  };
}

/** Dólares por `tokens` de um tipo. */
export function costOf(price: ModelPrice, kind: PriceKind, tokens: number): number {
  const perMillion =
    kind === 'in' ? price.input : kind === 'out' ? price.output : kind === 'cr' ? price.cacheRead : kind === 'cw' ? price.cacheWrite : price.cacheWrite1h;
  return (tokens * perMillion) / 1_000_000;
}
