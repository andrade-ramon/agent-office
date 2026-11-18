import { readConfig, writeConfig, type Paths } from './paths.js';

/**
 * Câmbio usado para mostrar o custo em reais no painel de dados. O
 * agent-office não consulta cotação nenhuma: sem um valor seu, o servidor usa
 * a referência embutida no código.
 */

/** Lê "5,43", "5.43" ou "R$ 5,43" (reais por dólar). */
export function parseRate(text: string): number | undefined {
  const cleaned = text.trim().replace(/^R\$\s*/i, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return undefined;
  const v = Number(cleaned);
  return v >= 0.01 && v <= 1000 ? v : undefined;
}

export function formatRate(rate: number): string {
  return `US$ 1 = R$ ${rate.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

/** Câmbio definido por você no config.json, se houver. */
export function currentRate(paths: Paths): number | undefined {
  const v = readConfig(paths).usdBrl;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Grava o câmbio no config.json. O servidor relê o arquivo sozinho. */
export function setRate(paths: Paths, text: string): { ok: boolean; detail: string; rate?: number } {
  const rate = parseRate(text);
  if (rate === undefined) return { ok: false, detail: `"${text}" não é um câmbio válido: informe quantos reais vale um dólar (ex.: 5,43)` };
  writeConfig(paths, { ...readConfig(paths), usdBrl: rate });
  return { ok: true, detail: formatRate(rate), rate };
}

/** Volta à referência embutida. Devolve false se não havia um câmbio seu. */
export function resetRate(paths: Paths): boolean {
  const { usdBrl, ...rest } = readConfig(paths);
  if (usdBrl === undefined) return false;
  writeConfig(paths, rest);
  return true;
}
