import { describe, expect, it } from 'vitest';
import type { UsageResponse, UsageTotals } from '../../server/src/schema';
import { boardModel, formatCount, shortModel } from '../src/game/boardModel';
import { MAP_H, MAP_W, OFFICE, TILE } from '../src/game/layout';
import { isWalkable } from '../src/game/pathfinding';
import { formatHours, formatTokens } from '../src/i18n';

function totals(over: Partial<Omit<UsageTotals, 'tokens'>> & { tokens?: number } = {}): UsageTotals {
  const { tokens = 0, ...rest } = over;
  return {
    tokens: { input: 0, output: 0, cacheRead: tokens, cacheWrite: 0, total: tokens },
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
      ...totals({ prompts: 5850, tools: 59_264, sessions: 1651, subagents: 560, activeMs: 184.4 * 3_600_000, subagentActiveMs: 29.6 * 3_600_000 }),
      tokens: { input: 17_819_575, output: 37_131_355, cacheRead: 14_764_957_086, cacheWrite: 189_523_779, total: 15_009_431_795 },
    },
    today: totals({ tokens: 23_229_444, prompts: 12, tools: 81, activeMs: 30 * 60_000 }),
    week: totals({ tokens: 2_305_538_510, prompts: 403, tools: 11_382, activeMs: 28.3 * 3_600_000 }),
    byAgent: { claude: totals({ tokens: 12_867_060_149 }), codex: totals({ tokens: 2_142_371_646 }) },
    days: Array.from({ length: 14 }, (_, i) => ({ day: day - (13 - i) * 86_400_000, claude: i * 10, codex: i === 13 ? 5 : 0, prompts: i, activeMs: 0 })),
    toolsByCategory: { read: 4321, write: 2024, edit: 4241, bash: 37_133, search: 665, web: 4227, plan: 2909, other: 3744 },
    models: [
      { name: 'claude-sonnet-5-5', tokens: 4_168_662_917 },
      { name: 'gpt-6.1-sol', tokens: 1_954_113_686 },
      { name: 'claude-fable-5-2', tokens: 798_179_046 },
    ],
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

  it('contagens ficam inteiras até 9.999', () => {
    expect(formatCount(5850)).toBe('5.850');
    expect(formatCount(59_264)).toBe('59,3 mil');
    expect(shortModel('claude-sonnet-5-5')).toBe('sonnet-5-5');
    expect(shortModel('gpt-6.1-sol')).toBe('gpt-6.1-sol');
  });
});

describe('boardModel (o que o telão escreve)', () => {
  it('monta os cinco indicadores com hoje e 7 dias', () => {
    const m = boardModel(usage());
    expect(m.kpis.map((k) => [k.label, k.format(k.value), k.sub])).toEqual([
      ['TOKENS', '15,01 bi', 'hoje 23,23 mi · 7 d 2,31 bi'],
      ['PROMPTS', '5.850', 'hoje 12 · 7 d 403'],
      ['TEMPO ATIVO', '184,4 h', 'hoje 30 min · 7 d 28,3 h'],
      ['SESSÕES', '1.651', '+ 560 subagentes'],
      ['FERRAMENTAS', '59,3 mil', 'hoje 81 · 7 d 11,4 mil'],
    ]);
    expect(m.mix).toEqual(['entrada 17,82 mi', 'saída 37,13 mi', 'cache lido 14,76 bi', 'cache gravado 189,52 mi']);
    expect(m.detail).toBe('acumulado desde 18/07/2026 · 80 dias com atividade');
    expect(m).toMatchObject({ status: 'ao vivo', live: true, barMax: 135 });
    expect(m.bars).toHaveLength(14);
    expect(m.bars.at(-1)).toEqual({ claude: 130, codex: 5, today: true });
  });

  it('reveza quadros com os destaques', () => {
    const pages = boardModel(usage()).pages;
    expect(pages.map((p) => p.title)).toEqual(['MODELOS', 'PROJETOS', 'FERRAMENTAS POR TIPO', 'AGENTES', 'SUBAGENTES', 'DIA RECORDE']);
    expect(pages[0]!.rows).toEqual([
      ['sonnet-5-5', '4,17 bi'],
      ['gpt-6.1-sol', '1,95 bi'],
    ]);
    expect(pages[1]!.rows[0]![0]).toBe('um-projeto-de-…');
    expect(pages[2]!.rows).toEqual([
      ['Terminal', '63%'],
      ['Leitura', '7,3%'],
    ]);
    expect(pages[3]!.rows).toEqual([
      ['Claude', '12,87 bi'],
      ['Codex', '2,14 bi'],
    ]);
    expect(pages[5]!.rows).toEqual([
      ['data', '24/09/2026'],
      ['tokens', '1,36 bi'],
    ]);
  });

  it('avisa enquanto lê o histórico e quando ainda não há dados', () => {
    const scanning = boardModel(usage({ scan: { pending: 1240, done: 20, scanning: true } }));
    expect(scanning).toMatchObject({ status: 'lendo o histórico · faltam 1.240 arquivos', live: false });

    const empty = boardModel(null);
    expect(empty.kpis.map((k) => k.format(k.value))).toEqual(['—', '—', '—', '—', '—']);
    expect(empty.pages).toEqual([]);

    const fresh = boardModel(usage({ since: null, activeDays: 0, allTime: totals(), models: [], projects: [], busiestDay: null }));
    expect(fresh.detail).toBe('nenhuma sessão registrada ainda');
    expect(fresh.kpis[0]!.format(fresh.kpis[0]!.value)).toBe('0');
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
