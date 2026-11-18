import type { ToolCategory, UsageResponse, UsageTotals } from '@agent-office/server/schema';
import {
  CATEGORY_LABEL,
  formatDate,
  formatHours,
  formatHoursShort,
  formatNumber,
  formatTokens,
  formatUsd,
  formatUsdShort,
} from '../i18n';

/**
 * O que o telão do painel de dados mostra, já em texto. Sem Pixi: só
 * transforma a resposta do servidor em rótulos, para poder ser testado.
 */

export interface BoardKpi {
  label: string;
  /** Valor acumulado (animado até chegar aqui). */
  value: number;
  format(value: number): string;
  /** Linha de apoio: hoje e últimos 7 dias. */
  sub: string;
}

export interface BoardBar {
  claude: number;
  codex: number;
  today: boolean;
}

export interface BoardPage {
  title: string;
  rows: [name: string, value: string][];
}

export interface BoardModel {
  /** Complemento do título: desde quando há dados. */
  detail: string;
  status: string;
  live: boolean;
  kpis: BoardKpi[];
  /** Composição dos tokens: entrada, saída, cache lido, cache gravado. */
  mix: string[];
  bars: BoardBar[];
  /** Maior dia do gráfico (escala das barras). */
  barMax: number;
  /** Quadros que se revezam no canto do telão. */
  pages: BoardPage[];
}

export const KPI_LABELS = ['TOKENS', 'CUSTO ESTIMADO', 'PROMPTS', 'TEMPO ATIVO', 'SESSÕES', 'FERRAMENTAS'] as const;
export const MIX_LABELS = ['entrada', 'saída', 'cache lido', 'cache gravado'] as const;

/** Contagens grandes: inteiras até 9.999, depois "59,3 mil". */
export function formatCount(n: number): string {
  return n < 10_000 ? formatNumber(Math.round(n)) : formatTokens(n);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** `claude-sonnet-5-5` → `sonnet-5-5`. */
export function shortModel(name: string): string {
  return clip(name.replace(/^claude-/, ''), 15);
}

function pct(part: number, total: number): string {
  if (total <= 0) return '0%';
  const v = (part / total) * 100;
  return `${v >= 10 || v === 0 ? Math.round(v) : v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}

function recent(today: string, week: string): string {
  return `hoje ${today} · 7 d ${week}`;
}

export function boardModel(usage: UsageResponse | null): BoardModel {
  if (!usage) {
    return {
      detail: 'aguardando o servidor',
      status: 'sem dados',
      live: false,
      kpis: KPI_LABELS.map((label) => ({ label, value: 0, format: () => '—', sub: '' })),
      mix: MIX_LABELS.map((label) => `${label} —`),
      bars: [],
      barMax: 0,
      pages: [],
    };
  }

  const all = usage.allTime;
  const pick = (get: (t: UsageTotals) => number, format: (n: number) => string): string =>
    recent(format(get(usage.today)), format(get(usage.week)));

  // Com algum modelo fora da tabela de preços, o total é um piso.
  const partial = usage.cost.unpricedTokens > 0;
  const kpis: BoardKpi[] = [
    { label: KPI_LABELS[0], value: all.tokens.total, format: formatTokens, sub: pick((t) => t.tokens.total, formatTokens) },
    {
      label: KPI_LABELS[1],
      value: all.costUsd,
      format: (v) => `${partial ? '≥ ' : ''}${formatUsd(v)}`,
      sub: pick((t) => t.costUsd, formatUsdShort),
    },
    { label: KPI_LABELS[2], value: all.prompts, format: formatCount, sub: pick((t) => t.prompts, formatCount) },
    { label: KPI_LABELS[3], value: all.activeMs, format: formatHours, sub: pick((t) => t.activeMs, formatHoursShort) },
    {
      label: KPI_LABELS[4],
      value: all.sessions,
      format: formatCount,
      sub: `+ ${formatCount(all.subagents)} ${all.subagents === 1 ? 'subagente' : 'subagentes'}`,
    },
    { label: KPI_LABELS[5], value: all.tools, format: formatCount, sub: pick((t) => t.tools, formatCount) },
  ];

  const t = all.tokens;
  const mix = [t.input, t.output, t.cacheRead, t.cacheWrite].map((v, i) => `${MIX_LABELS[i]!} ${formatTokens(v)}`);

  const last = usage.days.length - 1;
  const bars = usage.days.map((d, i) => ({ claude: d.claude, codex: d.codex, today: i === last }));
  const barMax = bars.reduce((m, b) => Math.max(m, b.claude + b.codex), 0);

  const pages: BoardPage[] = [];
  if (usage.models.length > 0) {
    pages.push({ title: 'MODELOS', rows: usage.models.slice(0, 2).map((m) => [shortModel(m.name), formatTokens(m.tokens)]) });
  }
  const byCost = usage.models.filter((m) => (m.costUsd ?? 0) > 0).sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));
  if (byCost.length > 0) {
    pages.push({ title: 'CUSTO POR MODELO', rows: byCost.slice(0, 2).map((m) => [shortModel(m.name), formatUsd(m.costUsd ?? 0)]) });
  }
  if (usage.projects.length > 0) {
    pages.push({ title: 'PROJETOS', rows: usage.projects.slice(0, 2).map((p) => [clip(p.name, 15), formatTokens(p.tokens)]) });
  }
  const tools = (Object.entries(usage.toolsByCategory) as [ToolCategory, number][])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  if (tools.length > 0) {
    pages.push({ title: 'FERRAMENTAS POR TIPO', rows: tools.slice(0, 2).map(([cat, count]) => [CATEGORY_LABEL[cat], pct(count, all.tools)]) });
  }
  if (t.total > 0) {
    pages.push({
      title: 'AGENTES',
      rows: [
        ['Claude', formatTokens(usage.byAgent.claude.tokens.total)],
        ['Codex', formatTokens(usage.byAgent.codex.tokens.total)],
      ],
    });
  }
  if (all.costUsd > 0) {
    pages.push({
      title: 'CUSTO POR AGENTE',
      rows: [
        ['Claude', formatUsd(usage.byAgent.claude.costUsd)],
        ['Codex', formatUsd(usage.byAgent.codex.costUsd)],
      ],
    });
  }
  if (partial) {
    pages.push({ title: 'MODELOS SEM PREÇO', rows: usage.cost.unpriced.slice(0, 2).map((m) => [shortModel(m.name), formatTokens(m.tokens)]) });
  }
  if (all.subagents > 0) {
    pages.push({
      title: 'SUBAGENTES',
      rows: [
        ['sessões', formatCount(all.subagents)],
        ['tempo ativo', formatHours(all.subagentActiveMs)],
      ],
    });
  }
  if (usage.busiestDay) {
    pages.push({
      title: 'DIA RECORDE',
      rows: [
        ['data', formatDate(usage.busiestDay.day)],
        ['tokens', formatTokens(usage.busiestDay.tokens)],
      ],
    });
  }

  const scan = usage.scan;
  const detail =
    usage.since === null
      ? 'nenhuma sessão registrada ainda'
      : `acumulado desde ${formatDate(usage.since)} · ${formatNumber(usage.activeDays)} ${usage.activeDays === 1 ? 'dia' : 'dias'} com atividade`;
  return {
    detail,
    status: scan.scanning ? `lendo o histórico · faltam ${formatNumber(scan.pending)} arquivos` : 'ao vivo',
    live: !scan.scanning,
    kpis,
    mix,
    bars,
    barMax,
    pages,
  };
}
