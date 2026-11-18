import type { UsageResponse } from '@agent-office/server/schema';
import { Container, Graphics, Text } from 'pixi.js';
import { DATA_WALL_BEZEL } from './art/world';
import { boardModel, type BoardModel } from './boardModel';
import { TAG_FONT } from './character';
import type { PixelRect } from './layout';

/**
 * Conteúdo do telão do painel de dados. A moldura é pixel art (faz parte do
 * mapa); os números são texto de verdade, redesenhado na resolução da tela a
 * cada mudança de zoom, para continuar legível de longe e nítido de perto.
 * Fica acima da camada da noite: é uma tela, tem luz própria.
 */

const INK = {
  bright: 0xf2f7ff,
  muted: 0x8ea0c0,
  dim: 0x61708f,
  line: 0x17233b,
  cyan: 0x6fd3ff,
  green: 0x6fe3a0,
  amber: 0xffd166,
  pink: 0xff8fb1,
  purple: 0xb79cff,
  blue: 0x7fb2ff,
  claude: 0xe8885a,
  codex: 0x7fb2ff,
} as const;

const KPI_COLORS = [INK.amber, INK.green, INK.blue, INK.cyan, INK.pink, INK.purple];
const MIX_COLORS = [INK.green, INK.amber, INK.blue, INK.purple];
/** Colunas dos indicadores (x e largura útil, em pixels do mundo). */
const COLS = [
  { x: 8, w: 104 },
  { x: 118, w: 98 },
  { x: 222, w: 66 },
  { x: 294, w: 96 },
  { x: 396, w: 70 },
  { x: 472, w: 90 },
] as const;
const MIX_STEP = 126;
const CHART = { x: 262, y: 60, w: 196, h: 13, bar: 12, gap: 2 } as const;
const SIDE = { x: 466, w: 96 } as const;
const ROWS_Y = [59.5, 66.6] as const;
/** Cada quadro do canto fica este tempo na tela. */
const PAGE_MS = 6000;
/** Quanto os números demoram para alcançar um valor novo. */
const COUNT_MS = 320;

type Weight = '400' | '700';

export class DataBoard {
  readonly view = new Container();
  private readonly w: number;
  private readonly texts: Text[] = [];
  private readonly chart = new Graphics();
  private readonly liveDot = new Graphics();
  private readonly detail: Text;
  private readonly status: Text;
  private readonly kpiValue: Text[] = [];
  private readonly kpiSub: Text[] = [];
  private readonly mix: Text[] = [];
  private readonly pageTitle: Text;
  private readonly pageName: Text[] = [];
  private readonly pageValue: Text[] = [];
  private model: BoardModel = boardModel(null);
  private readonly shown: number[] = COLS.map(() => 0);
  private readonly shownText: string[] = COLS.map(() => '');
  private clock = 0;
  private page = -1;
  private res = 1;
  private titleEnd = 0;

  constructor(rect: PixelRect) {
    const b = DATA_WALL_BEZEL;
    this.view.position.set(rect.x + b, rect.y + b);
    this.w = rect.w - b * 2;

    const lines = new Graphics();
    lines.rect(6, 11, this.w - 12, 1).rect(6, 50, this.w - 12, 1);
    for (const col of COLS.slice(1)) lines.rect(col.x - 4, 14, 1, 34);
    lines.rect(CHART.x - 5, 53, 1, 21).rect(SIDE.x - 5, 53, 1, 21);
    lines.fill({ color: INK.line });
    this.view.addChild(lines, this.chart, this.liveDot);

    const title = this.text('PAINEL DE DADOS', 8, 2.6, 6, INK.cyan, '700', 0.5);
    this.titleEnd = title.x + title.width;
    this.detail = this.text('', this.titleEnd + 5, 2.6, 6, INK.muted);
    this.status = this.text('', this.w - 8, 2.6, 6, INK.muted, '700');
    this.status.anchor.set(1, 0);

    COLS.forEach((col, i) => {
      this.text(this.model.kpis[i]!.label, col.x, 13.4, 6.4, KPI_COLORS[i]!, '700', 0.4);
      this.kpiValue.push(this.text('—', col.x - 0.5, 20.2, 16, INK.bright, '700'));
      this.kpiSub.push(this.text('', col.x, 41, 6.3, INK.muted));
    });

    this.text('COMPOSIÇÃO DOS TOKENS', 8, 52.6, 5.8, INK.dim, '700', 0.3);
    for (let i = 0; i < 4; i++) {
      this.mix.push(this.text('', 13 + (i % 2) * MIX_STEP, ROWS_Y[Math.floor(i / 2)]!, 6.3, INK.muted));
    }

    this.text('ÚLTIMOS 14 DIAS', CHART.x, 52.6, 5.8, INK.dim, '700', 0.3);
    const codex = this.text('Codex', CHART.x + CHART.w, 52.6, 5.8, INK.muted);
    codex.anchor.set(1, 0);
    const claude = this.text('Claude', CHART.x + CHART.w - codex.width - 9, 52.6, 5.8, INK.muted);
    claude.anchor.set(1, 0);
    const legend = new Graphics();
    legend.rect(codex.x - codex.width - 5, 54.6, 3, 3).fill({ color: INK.codex });
    legend.rect(claude.x - claude.width - 5, 54.6, 3, 3).fill({ color: INK.claude });
    this.view.addChild(legend);

    this.pageTitle = this.text('', SIDE.x, 52.6, 5.8, INK.dim, '700', 0.3);
    for (const y of ROWS_Y) {
      this.pageName.push(this.text('', SIDE.x, y, 6.3, INK.muted));
      const value = this.text('', SIDE.x + SIDE.w, y, 6.3, INK.bright, '700');
      value.anchor.set(1, 0);
      this.pageValue.push(value);
    }

    this.render();
  }

  private text(content: string, x: number, y: number, size: number, color: number, weight: Weight = '400', spacing = 0): Text {
    const t = new Text({
      text: content,
      style: { fontFamily: TAG_FONT, fontSize: size, fontWeight: weight, fill: color, letterSpacing: spacing },
    });
    t.resolution = this.res;
    t.position.set(x, y);
    this.view.addChild(t);
    this.texts.push(t);
    return t;
  }

  /** Encolhe o texto se ele não couber na coluna (fontes diferentes, números enormes). */
  private fit(t: Text, maxW: number): void {
    t.scale.set(1);
    const w = t.width;
    if (w > maxW && w > 0) t.scale.set(maxW / w);
  }

  /** Pixels de textura por pixel do mundo (zoom × densidade da tela). */
  setResolution(res: number): void {
    if (res === this.res) return;
    this.res = res;
    for (const t of this.texts) t.resolution = res;
  }

  setUsage(usage: UsageResponse | null): void {
    this.model = boardModel(usage);
    this.render();
  }

  private render(): void {
    const m = this.model;
    this.detail.text = m.detail;
    this.status.text = m.status;
    this.status.style.fill = m.live ? INK.green : INK.amber;
    this.fit(this.detail, this.w - 8 - this.status.width - 12 - (this.titleEnd + 5));
    this.liveDot.clear();
    this.liveDot.rect(this.w - 8 - this.status.width - 6, 5, 3, 3).fill({ color: m.live ? INK.green : INK.amber });

    m.kpis.forEach((kpi, i) => {
      this.kpiSub[i]!.text = kpi.sub;
      this.fit(this.kpiSub[i]!, COLS[i]!.w);
    });
    m.mix.forEach((label, i) => {
      this.mix[i]!.text = label;
      this.fit(this.mix[i]!, MIX_STEP - 10);
    });
    this.drawChart();
    this.page = -1;
    this.step(0);
  }

  private drawChart(): void {
    const g = this.chart;
    const m = this.model;
    g.clear();
    for (let i = 0; i < 4; i++) {
      g.rect(8 + (i % 2) * MIX_STEP, ROWS_Y[Math.floor(i / 2)]! + 2.2, 3, 3).fill({ color: MIX_COLORS[i]! });
    }
    const base = CHART.y + CHART.h;
    g.rect(CHART.x, base, CHART.w - CHART.gap, 1).fill({ color: INK.line });
    m.bars.forEach((bar, i) => {
      const x = CHART.x + i * (CHART.bar + CHART.gap);
      const total = bar.claude + bar.codex;
      if (total <= 0 || m.barMax <= 0) {
        g.rect(x, base - 1, CHART.bar, 1).fill({ color: INK.dim, alpha: 0.5 });
      } else {
        // Raiz quadrada: um dia fora da curva não achata todos os outros.
        const h = Math.max(1, Math.round(Math.sqrt(total / m.barMax) * CHART.h));
        const claude = Math.round((bar.claude / total) * h);
        const alpha = bar.today ? 1 : 0.78;
        if (claude > 0) g.rect(x, base - claude, CHART.bar, claude).fill({ color: INK.claude, alpha });
        if (h - claude > 0) g.rect(x, base - h, CHART.bar, h - claude).fill({ color: INK.codex, alpha });
      }
      if (bar.today) g.rect(x, base + 1, CHART.bar, 1).fill({ color: INK.bright });
    });
  }

  /** Avança as animações: contagem dos números, revezamento dos quadros, luz de "ao vivo". */
  update(dtMs: number): void {
    this.step(dtMs);
  }

  private step(dtMs: number): void {
    this.clock += dtMs;
    const m = this.model;
    const k = 1 - Math.exp(-dtMs / COUNT_MS);
    m.kpis.forEach((kpi, i) => {
      const gap = kpi.value - this.shown[i]!;
      if (gap !== 0) this.shown[i] = Math.abs(gap) < Math.max(1, Math.abs(kpi.value) * 0.0005) ? kpi.value : this.shown[i]! + gap * k;
      const label = kpi.format(this.shown[i]!);
      if (label === this.shownText[i]) return;
      this.shownText[i] = label;
      this.kpiValue[i]!.text = label;
      this.fit(this.kpiValue[i]!, COLS[i]!.w);
    });

    const page = m.pages.length > 0 ? Math.floor(this.clock / PAGE_MS) % m.pages.length : 0;
    if (page !== this.page) {
      this.page = page;
      const current = m.pages[page];
      this.pageTitle.text = current?.title ?? '';
      this.pageName.forEach((name, i) => {
        const row = current?.rows[i];
        this.pageValue[i]!.text = row?.[1] ?? '';
        name.text = row?.[0] ?? '';
        this.fit(name, SIDE.w - this.pageValue[i]!.width - 4);
      });
    }
    this.liveDot.alpha = m.live && Math.floor(this.clock / 800) % 2 === 1 ? 0.35 : 1;
  }

  /** O que está escrito agora (verificação automatizada). */
  debug(): Record<string, unknown> {
    return {
      status: this.status.text,
      detail: this.detail.text,
      kpis: this.model.kpis.map((kpi, i) => ({ label: kpi.label, value: this.kpiValue[i]!.text, sub: kpi.sub })),
      mix: this.mix.map((t) => t.text),
      page: { title: this.pageTitle.text, rows: this.pageName.map((n, i) => [n.text, this.pageValue[i]!.text]) },
      bars: this.model.bars.length,
      resolution: this.res,
    };
  }
}
