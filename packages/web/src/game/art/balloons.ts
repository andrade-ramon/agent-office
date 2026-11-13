import { ICONS, type IconName } from './icons';
import { makeSprite, type AtlasBuilder } from './painter';

/** Balões de fala / pensamento sobre a cabeça dos personagens. */

export type BalloonKind =
  | 'question'
  | 'exclaim'
  | 'check'
  | 'cross'
  | 'dots1'
  | 'dots2'
  | 'dots3'
  | 'zzz1'
  | 'zzz2'
  | 'cup'
  | 'terminal'
  | 'pencil'
  | 'book'
  | 'search'
  | 'globe'
  | 'plan'
  | 'gear'
  | 'chat';

interface Style {
  icon: IconName;
  bg: string;
  fg: string;
  thought?: boolean;
}

const WHITE = '#fbf8f0';

export const BALLOON_STYLES: Record<BalloonKind, Style> = {
  question: { icon: 'question', bg: '#ffd84a', fg: '#3a2a10' },
  exclaim: { icon: 'exclaim', bg: '#ff6b4a', fg: '#ffffff' },
  check: { icon: 'check', bg: '#58c878', fg: '#ffffff' },
  cross: { icon: 'cross', bg: '#e0504a', fg: '#ffffff' },
  dots1: { icon: 'dots1', bg: WHITE, fg: '#59647a', thought: true },
  dots2: { icon: 'dots2', bg: WHITE, fg: '#59647a', thought: true },
  dots3: { icon: 'dots3', bg: WHITE, fg: '#59647a', thought: true },
  zzz1: { icon: 'zzz1', bg: '#dbe8ff', fg: '#4a5f9a', thought: true },
  zzz2: { icon: 'zzz2', bg: '#dbe8ff', fg: '#4a5f9a', thought: true },
  cup: { icon: 'cup', bg: WHITE, fg: '#7a4a2e' },
  terminal: { icon: 'terminal', bg: '#1f2a24', fg: '#5fe08a' },
  pencil: { icon: 'pencil', bg: WHITE, fg: '#c9772a' },
  book: { icon: 'book', bg: WHITE, fg: '#3f6fb0' },
  search: { icon: 'search', bg: WHITE, fg: '#7a52b0' },
  globe: { icon: 'globe', bg: WHITE, fg: '#2a8fa8' },
  plan: { icon: 'plan', bg: WHITE, fg: '#b04a6a' },
  gear: { icon: 'gear', bg: WHITE, fg: '#59647a' },
  chat: { icon: 'chat', bg: WHITE, fg: '#3a3f4d' },
};

export const BALLOON_KINDS = Object.keys(BALLOON_STYLES) as BalloonKind[];

function balloonSprite(style: Style): HTMLCanvasElement {
  const rows = ICONS[style.icon];
  const iw = rows[0]!.length;
  const ih = rows.length;
  const w = iw + 6;
  const h = ih + 4;
  return makeSprite(w, h + 4, (p) => {
    p.rect(1, 0, w - 2, h, style.bg).rect(0, 1, w, h - 2, style.bg);
    p.rect(1, h - 1, w - 2, 1, 'rgba(0,0,0,0.12)');
    if (style.thought) {
      p.rect(3, h + 1, 2, 2, style.bg);
    } else {
      p.rect(3, h, 3, 1, style.bg).rect(3, h + 1, 2, 1, style.bg).px(3, h + 2, style.bg);
    }
    p.bitmap(3, 2, rows, { X: style.fg });
  });
}

export function addBalloons(atlas: AtlasBuilder): void {
  for (const kind of BALLOON_KINDS) atlas.add(`balloon-${kind}`, balloonSprite(BALLOON_STYLES[kind]));
}
