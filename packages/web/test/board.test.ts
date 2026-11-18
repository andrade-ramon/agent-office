import { describe, expect, it } from 'vitest';
import type { UsageResponse, UsageTotals } from '../../server/src/schema';
import { boardModel, formatCount, shortModel } from '../src/game/boardModel';
import { MAP_H, MAP_W, OFFICE, TILE } from '../src/game/layout';
import { isWalkable } from '../src/game/pathfinding';
import { formatBrl, formatHours, formatHoursShort, formatTokens, formatUsd } from '../src/i18n';

function totals(over: Partial<Omit<UsageTotals, 'tokens'>> & { tokens?: number } = {}): UsageTotals {
  const { tokens = 0, ...rest } = over;
  return {
    tokens: { input: 0, output: 0, cacheRead: tokens, cacheWrite: 0, total: tokens },
    costUsd: 0,
    prompts: 0,
    tools: 0,
    errors: 0,
    sessions: 0,
    subagents: 0,
    activeMs: 0,
    subagentActiveMs: 0,
    ...rest,
  };
}

function usage(over: Partial<UsageResponse> = {}): UsageResponse {
  const day = new Date(2026, 10, 18).getTime();
  return {
    since: new Date(2026, 6, 18).getTime(),
    updatedAt: day,
    allTime: {
      ...totals({ costUsd: 8412.37, prompts: 5850, tools: 59_264, sessions: 1651, subagents: 560, activeMs: 184.4 * 3_600_000, subagentActiveMs: 29.6 * 3_600_000 }),
      tokens: { input: 17_819_575, output: 37_131_355, cacheRead: 14_764_957_086, cacheWrite: 189_523_779, total: 15_009_431_795 },
    },
    today: totals({ tokens: 23_229_444, costUsd: 34.2, prompts: 12, tools: 81, sessions: 3, activeMs: 63 * 60_000 }),
    week: totals({ tokens: 2_305_538_510, costUsd: 1204.4, prompts: 403, tools: 11_382, sessions: 59, activeMs: 28.3 * 3_600_000 }),
    byAgent: { claude: totals({ tokens: 12_867_060_149, costUsd: 8100.07 }), codex: totals({ tokens: 2_142_371_646, costUsd: 312.3 }) },
    days: Array.from({ length: 14 }, (_, i) => ({ day: day - (13 - i) * 86_400_000, claude: i * 10, codex: i === 13 ? 5 : 0, prompts: i, activeMs: 0 })),
    toolsByCategory: { read: 4321, write: 2024, edit: 4241, bash: 37_133, search: 665, web: 4227, plan: 2909, other: 3744 },
    models: [
      { name: 'claude-sonnet-5-5', tokens: 4_168_662_917, costUsd: 900 },
      { name: 'gpt-6.1-sol', tokens: 1_954_113_686, costUsd: 260.5 },
      { name: 'claude-fable-5-2', tokens: 798_179_046, costUsd: 1500 },
    ],
    cost: { pricesAsOf: '2026-11-18', unpricedTokens: 0, unpriced: [], usdBrl: 5.5, usdBrlAsOf: '2026-11-17' },
    projects: [{ name: 'um-projeto-de-nome-bem-comprido', tokens: 9_000_000 }],
    activeDays: 80,
    busiestDay: { day: new Date(2026, 8, 24).getTime(), tokens: 1_362_026_107 },
    scan: { pending: 0, done: 0, scanning: false },
    ...over,
  };
}

describe('formatadores do painel de dados', () => {
  it('abrevia tokens em mil, mi e bi', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(45_300)).toBe('45,3 mil');
    expect(formatTokens(999_960)).toBe('1 mi');
    expect(formatTokens(23_229_444)).toBe('23,23 mi');
    expect(formatTokens(999_996_000)).toBe('1 bi');
    expect(formatTokens(15_009_431_795)).toBe('15,01 bi');
  });

  it('mostra o tempo somado em minutos, horas e minutos ou horas', () => {
    expect(formatHours(0)).toBe('0 min');
    expect(formatHours(42 * 60_000)).toBe('42 min');
    expect(formatHours((8 * 60 + 5) * 60_000)).toBe('8 h 05 min');
    expect(formatHours(184.4 * 3_600_000)).toBe('184,4 h');
    expect(formatHours(1234.5 * 3_600_000)).toBe('1.234,5 h');
  });

  it('formata dólares conforme o tamanho do valor', () => {
    expect(formatUsd(0)).toBe('US$ 0,00');
    expect(formatUsd(34.2)).toBe('US$ 34,20');
    expect(formatUsd(8412.37)).toBe('US$ 8.412');
    expect(formatUsd(123_456)).toBe('US$ 123,5 mil');
    expect(formatUsd(1_234_567)).toBe('US$ 1,23 mi');
    expect(formatBrl(34.618)).toBe('R$ 34,62');
    expect(formatBrl(340.618)).toBe('R$ 341');
    expect(formatBrl(23_610.4)).toBe('R$ 23.610');
    expect(formatHoursShort(52 * 60_000)).toBe('52 min');
    expect(formatHoursShort(63 * 60_000)).toBe('1h03');
    expect(formatHoursShort(28.8 * 3_600_000)).toBe('28,8 h');
  });

  it('contagens ficam inteiras até 9.999', () => {
    expect(formatCount(5850)).toBe('5.850');
    expect(formatCount(59_264)).toBe('59,3 mil');
    expect(shortModel('claude-sonnet-5-5')).toBe('sonnet-5-5');
    expect(shortModel('gpt-6.1-sol')).toBe('gpt-6.1-sol');
  });
});

describe('boardModel (o que o telão escreve)', () => {
  it('monta os indicadores com hoje e 7 dias, e o custo em dólares e em reais', () => {
    const m = boardModel(usage());
    expect(m.kpis.map((k) => [k.label, k.format(k.value), ...k.subs])).toEqual([
      ['TOKENS', '15,01 bi', 'hoje 23,23 mi', '7 dias 2,31 bi'],
      ['CUSTO ESTIMADO', 'US$ 8.412', 'hoje 34,20', '7 dias 1.204'],
      // câmbio de 5,50: 8.412,37 × 5,5 = 46.268
      ['CUSTO EM REAIS', 'R$ 46.268', 'hoje 188', '7 dias 6.624'],
      ['PROMPTS', '5.850', 'hoje 12', '7 dias 403'],
      ['TEMPO ATIVO', '184,4 h', 'hoje 1h03', '7 dias 28,3 h'],
      ['SESSÕES', '1.651', 'hoje 3 · 7 d 59', '+ 560 subagentes'],
      ['FERRAMENTAS', '59,3 mil', 'hoje 81', '7 dias 11,4 mil'],
    ]);
    expect(m.mix).toEqual(['entrada 17,82 mi', 'saída 37,13 mi', 'cache lido 14,76 bi', 'cache gravado 189,52 mi']);
    expect(m.detail).toBe('acumulado desde 18/07/2026 · 80 dias com atividade · US$ 1 = R$ 5,50');
    expect(m).toMatchObject({ status: 'ao vivo', live: true, barMax: 135 });
    expect(m.bars).toHaveLength(14);
    expect(m.bars.at(-1)).toEqual({ claude: 130, codex: 5, today: true });
  });

  it('reveza quadros com os destaques', () => {
    const pages = boardModel(usage()).pages;
    expect(pages.map((p) => p.title)).toEqual([
      'MODELOS',
      'CUSTO POR MODELO',
      'PROJETOS',
      'FERRAMENTAS POR TIPO',
      'AGENTES',
      'CUSTO POR AGENTE',
      'SUBAGENTES',
      'DIA RECORDE',
    ]);
    // O mais usado em tokens nem sempre é o mais caro.
    expect(pages[1]!.rows).toEqual([
      ['fable-5-2', 'US$ 1.500'],
      ['sonnet-5-5', 'US$ 900'],
    ]);
    expect(pages[5]!.rows).toEqual([
      ['Claude', 'US$ 8.100'],
      ['Codex', 'US$ 312'],
    ]);
    expect(pages[0]!.rows).toEqual([
      ['sonnet-5-5', '4,17 bi'],
      ['gpt-6.1-sol', '1,95 bi'],
    ]);
    expect(pages[2]!.rows[0]![0]).toBe('um-projeto-de-…');
    expect(pages[3]!.rows).toEqual([
      ['Terminal', '63%'],
      ['Leitura', '7,3%'],
    ]);
    expect(pages[4]!.rows).toEqual([
      ['Claude', '12,87 bi'],
      ['Codex', '2,14 bi'],
    ]);
    expect(pages[7]!.rows).toEqual([
      ['data', '24/09/2026'],
      ['tokens', '1,36 bi'],
    ]);
  });

  it('avisa enquanto lê o histórico e quando ainda não há dados', () => {
    const scanning = boardModel(usage({ scan: { pending: 1240, done: 20, scanning: true } }));
    expect(scanning).toMatchObject({ status: 'lendo o histórico · faltam 1.240 arquivos', live: false });

    const empty = boardModel(null);
    expect(empty.kpis.map((k) => k.format(k.value))).toEqual(['—', '—', '—', '—', '—', '—', '—']);
    expect(empty.pages).toEqual([]);

    const fresh = boardModel(usage({ since: null, activeDays: 0, allTime: totals(), models: [], projects: [], busiestDay: null }));
    expect(fresh.detail).toBe('nenhuma sessão registrada ainda');
    expect(fresh.kpis[0]!.format(fresh.kpis[0]!.value)).toBe('0');
    expect(fresh.kpis[1]!.format(fresh.kpis[1]!.value)).toBe('US$ 0,00');
    expect(fresh.kpis[2]!.format(fresh.kpis[2]!.value)).toBe('R$ 0,00');
  });

  it('marca o custo como piso quando algum modelo não tem preço', () => {
    const m = boardModel(
      usage({ cost: { pricesAsOf: '2026-11-18', unpricedTokens: 5_000_000, unpriced: [{ name: 'modelo-novo-9', tokens: 5_000_000 }], usdBrl: 5.5, usdBrlAsOf: null } }),
    );
    expect(m.kpis[1]!.format(8412.37)).toBe('≥ US$ 8.412');
    expect(m.kpis[2]!.format(46_268)).toBe('≥ R$ 46.268');
    expect(m.pages.find((p) => p.title === 'MODELOS SEM PREÇO')?.rows).toEqual([['modelo-novo-9', '5 mi']]);
  });
});

describe('telão no mapa', () => {
  it('fica inteiro sobre a parede da ala de baixo', () => {
    const r = OFFICE.dashboard;
    expect(r.x).toBeGreaterThan(0);
    expect(r.x + r.w).toBeLessThan(MAP_W * TILE);
    expect(r.y + r.h).toBeLessThan(MAP_H * TILE);
    for (const [px, py] of [
      [r.x, r.y],
      [r.x + r.w - 1, r.y],
      [r.x, r.y + r.h - 1],
      [r.x + r.w - 1, r.y + r.h - 1],
    ] as const) {
      expect(OFFICE.tiles[Math.floor(py / TILE) * OFFICE.w + Math.floor(px / TILE)]).toBe('face');
    }
  });

  it('tem lugares para assistir, de frente para ele', () => {
    const watch = OFFICE.slots.copa.filter((s) => s.tag === 'watch');
    expect(watch.length).toBeGreaterThanOrEqual(4);
    const bottom = (OFFICE.dashboard.y + OFFICE.dashboard.h) / TILE;
    for (const s of watch) {
      expect(s.facing).toBe('up');
      expect(s.y).toBeGreaterThan(bottom);
      expect(isWalkable(OFFICE, s.x, s.y)).toBe(true);
    }
  });
});
