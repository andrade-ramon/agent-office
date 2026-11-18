import { describe, expect, it } from 'vitest';
import { USD_BRL, costOf, parsePrices, parseUsdBrl, priceOf, priceVariant, splitPriceKey } from '../src/pricing.js';

const usage = (prompt: number) => ({ input: prompt, output: 10, cacheRead: 0, cacheWrite: 0 });

describe('tabela de preços', () => {
  it('traz entrada, saída e cache de cada modelo (US$ por milhão de tokens)', () => {
    expect(priceOf('claude-fable-5-2')).toEqual({ input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10, cacheWrite1h: 16 });
    expect(priceOf('claude-sonnet-5-5')).toMatchObject({ input: 2, output: 10, cacheRead: 0.1 });
    expect(priceOf('claude-sonnet-5')).toMatchObject({ input: 2, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 });
    expect(priceOf('claude-opus-5-5')).toMatchObject({ input: 4, output: 20, cacheRead: 0.2 });
    expect(priceOf('gpt-6.1-sol')).toMatchObject({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
    expect(priceOf('gpt-6-luna')).toMatchObject({ input: 0.1, output: 0.5, cacheRead: 0.01 });
  });

  it('aceita sufixos que não mudam o preço e recusa versões que não conhece', () => {
    expect(priceOf('claude-haiku-4-5-20251001')).toEqual(priceOf('claude-haiku-4-5'));
    expect(priceOf('gpt-5-codex')).toEqual(priceOf('gpt-5'));
    expect(priceOf('gpt-5.1-codex-max')).toEqual(priceOf('gpt-5.1'));
    // Uma versão nova não herda o preço da anterior: fica sem preço até entrar na tabela.
    expect(priceOf('claude-sonnet-5-7')).toBeNull();
    expect(priceOf('gpt-5.7')).toBeNull();
    expect(priceOf('modelo-desconhecido')).toBeNull();
  });

  it('modo rápido e prompt longo mudam o preço da requisição', () => {
    expect(priceVariant('claude-opus-5', usage(1000), true)).toBe('+fast');
    expect(priceVariant('claude-sonnet-5-5', usage(1000), true)).toBe('');
    expect(priceOf('claude-opus-5+fast')).toEqual({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20 });

    expect(priceVariant('claude-haiku-5-5', usage(100_000), false)).toBe('');
    expect(priceVariant('claude-haiku-5-5', { input: 10, output: 5, cacheRead: 90_000, cacheWrite: 20_000 }, false)).toBe('+long');
    expect(priceOf('claude-haiku-5-5+long')).toEqual({ input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625, cacheWrite1h: 1 });
    expect(priceVariant('claude-opus-5-5', usage(900_000), false)).toBe('');
    expect(splitPriceKey('claude-opus-5+fast')).toEqual({ model: 'claude-opus-5', variant: '+fast' });
    expect(splitPriceKey('gpt-6.1-sol')).toEqual({ model: 'gpt-6.1-sol', variant: '' });
  });

  it('calcula o custo por tipo de token', () => {
    const p = priceOf('claude-fable-5-2')!;
    expect(costOf(p, 'in', 1_000_000)).toBe(8);
    expect(costOf(p, 'out', 500_000)).toBe(20);
    expect(costOf(p, 'cr', 10_000_000)).toBe(2);
    expect(costOf(p, 'cw', 1_000_000)).toBe(10);
    expect(costOf(p, 'cw1h', 1_000_000)).toBe(16);
  });

  it('valida o câmbio do config.json', () => {
    expect(USD_BRL.rate).toBeGreaterThan(1);
    expect(parseUsdBrl(5.43)).toBe(5.43);
    expect(parseUsdBrl('5,43')).toBe(5.43);
    expect(parseUsdBrl(0)).toBeUndefined();
    expect(parseUsdBrl(-5)).toBeUndefined();
    expect(parseUsdBrl('caro')).toBeUndefined();
    expect(parseUsdBrl(undefined)).toBeUndefined();
    expect(parseUsdBrl(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('o config.json completa ou corrige a tabela', () => {
    const prices = parsePrices({
      'modelo-novo-9': { input: 1, output: 4 },
      'claude-opus-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.5, cacheWrite1h: 6 },
      quebrado: { input: 'caro' },
      negativo: { input: -1, output: 2 },
    });
    expect(Object.keys(prices)).toEqual(['modelo-novo-9', 'claude-opus-5']);
    expect(priceOf('modelo-novo-9', prices)).toEqual({ input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 });
    expect(priceOf('modelo-novo-9-20270101', prices)).toMatchObject({ input: 1 });
    expect(priceOf('claude-opus-5', prices)).toMatchObject({ input: 3, cacheWrite1h: 6 });
    // a variante continua valendo sobre o preço informado
    expect(priceOf('claude-opus-5+fast', prices)).toMatchObject({ input: 6, output: 30 });
    expect(priceOf('claude-opus-5')).toMatchObject({ input: 5 });
    expect(parsePrices(null)).toEqual({});
    expect(parsePrices([1, 2])).toEqual({});
  });
});
