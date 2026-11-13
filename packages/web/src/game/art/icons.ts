/**
 * Ícones em bitmap (X = pixel aceso). Usados nos balões da cena e, via SVG,
 * na interface — o mesmo desenho nos dois lugares.
 */

export type IconName =
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
  | 'chat'
  | 'door'
  | 'eye'
  | 'bell'
  | 'tag'
  | 'expand'
  | 'compact'
  | 'sun'
  | 'moon'
  | 'clock'
  | 'cycle'
  | 'target'
  | 'fit'
  | 'plus'
  | 'minus'
  | 'window'
  | 'help'
  | 'close';

export const ICONS: Record<IconName, readonly string[]> = {
  question: [
    '.XXXXX.',
    'XX...XX',
    '....XX.',
    '...XX..',
    '...XX..',
    '.......',
    '...XX..',
  ],
  exclaim: [
    '..XXX..',
    '..XXX..',
    '..XXX..',
    '...X...',
    '...X...',
    '.......',
    '..XXX..',
  ],
  check: [
    '.......',
    '......X',
    '.....XX',
    'X...XX.',
    'XX.XX..',
    '.XXX...',
    '..X....',
  ],
  cross: [
    'X.....X',
    'XX...XX',
    '.XX.XX.',
    '..XXX..',
    '.XX.XX.',
    'XX...XX',
    'X.....X',
  ],
  dots1: ['........', '........', '........', 'XX......', 'XX......', '........', '........'],
  dots2: ['........', '........', '........', 'XX.XX...', 'XX.XX...', '........', '........'],
  dots3: ['........', '........', '........', 'XX.XX.XX', 'XX.XX.XX', '........', '........'],
  zzz1: [
    '....XXX',
    '.....X.',
    '....XXX',
    '.......',
    'XXX....',
    '.X.....',
    'XXX....',
  ],
  zzz2: [
    'XXXX...',
    '..X....',
    '.X.....',
    'XXXX...',
    '....XXX',
    '.....X.',
    '....XXX',
  ],
  cup: [
    '.X.X...',
    '..X.X..',
    '.......',
    'XXXXXX.',
    'XXXXX.X',
    'XXXXXX.',
    '.XXX...',
  ],
  terminal: [
    '.......',
    'X......',
    '.X.....',
    '..X....',
    '.X.....',
    'X..XXXX',
    '.......',
  ],
  pencil: [
    '.....XX',
    '....XXX',
    '...XXX.',
    '..XXX..',
    '.XXX...',
    'XXX....',
    'XX.....',
  ],
  book: [
    '.......',
    'XXX.XXX',
    'X.XXX.X',
    'X..X..X',
    'X..X..X',
    'XXXXXXX',
    '.......',
  ],
  search: [
    '.XXX...',
    'X...X..',
    'X...X..',
    'X...X..',
    '.XXXX..',
    '....XX.',
    '.....XX',
  ],
  globe: [
    '.XXXXX.',
    'X.X.X.X',
    'XXXXXXX',
    'X.X.X.X',
    'XXXXXXX',
    'X.X.X.X',
    '.XXXXX.',
  ],
  plan: [
    'XX.XXXX',
    'XX.....',
    '.......',
    'XX.XXXX',
    'XX.....',
    '.......',
    'XX.XXXX',
  ],
  gear: [
    '..X.X..',
    '.XXXXX.',
    'XX...XX',
    '.X...X.',
    'XX...XX',
    '.XXXXX.',
    '..X.X..',
  ],
  chat: [
    'XXXXXXX',
    'X.....X',
    'X.X.X.X',
    'X.....X',
    'XXXXXXX',
    '..XX...',
    '..X....',
  ],
  door: [
    'XXXXXX.',
    'X....X.',
    'X....X.',
    'X..X.X.',
    'X....X.',
    'X....X.',
    'XXXXXXX',
  ],
  eye: [
    '.......',
    '..XXX..',
    '.X...X.',
    'X..X..X',
    '.X...X.',
    '..XXX..',
    '.......',
  ],
  bell: [
    '...X...',
    '..XXX..',
    '.XXXXX.',
    '.XXXXX.',
    '.XXXXX.',
    'XXXXXXX',
    '...X...',
  ],
  tag: [
    'XXXXX..',
    'X.X.XX.',
    'X....XX',
    'X.....X',
    'X....XX',
    'X...XX.',
    'XXXXX..',
  ],
  expand: [
    'XXX.XXX',
    'X.....X',
    'X.....X',
    '.......',
    'X.....X',
    'X.....X',
    'XXX.XXX',
  ],
  compact: [
    'XXXXXXX',
    'X.....X',
    'X.XXX.X',
    'X.XXX.X',
    'X.XXX.X',
    'X.....X',
    'XXXXXXX',
  ],
  sun: [
    '...X...',
    '.X...X.',
    '..XXX..',
    'X.XXX.X',
    '..XXX..',
    '.X...X.',
    '...X...',
  ],
  moon: [
    '..XXX..',
    '.XX....',
    'XX.....',
    'XX.....',
    'XX.....',
    '.XX...X',
    '..XXXX.',
  ],
  clock: [
    '.XXXXX.',
    'X..X..X',
    'X..X..X',
    'X..XX.X',
    'X.....X',
    'X.....X',
    '.XXXXX.',
  ],
  cycle: [
    '.XXXX.X',
    'X....XX',
    'X...XXX',
    '.......',
    'XXX...X',
    'XX....X',
    'X.XXXX.',
  ],
  target: [
    '...X...',
    '.XXXXX.',
    '.X...X.',
    'XX.X.XX',
    '.X...X.',
    '.XXXXX.',
    '...X...',
  ],
  fit: [
    'XX...XX',
    'X.....X',
    '..XXX..',
    '..X.X..',
    '..XXX..',
    'X.....X',
    'XX...XX',
  ],
  plus: [
    '.......',
    '...X...',
    '...X...',
    '.XXXXX.',
    '...X...',
    '...X...',
    '.......',
  ],
  minus: ['.......', '.......', '.......', '.XXXXX.', '.......', '.......', '.......'],
  window: [
    'XXXXXXX',
    'XXXXXXX',
    'X.....X',
    'X.....X',
    'X.....X',
    'X.....X',
    'XXXXXXX',
  ],
  help: [
    '.XXXXX.',
    'X.....X',
    'X.XXX.X',
    'X...X.X',
    'X..X..X',
    'X.....X',
    '.XXXXX.',
  ],
  close: [
    '.......',
    '.X...X.',
    '..X.X..',
    '...X...',
    '..X.X..',
    '.X...X.',
    '.......',
  ],
};

export function iconSize(name: IconName): { w: number; h: number } {
  const rows = ICONS[name];
  return { w: rows[0]!.length, h: rows.length };
}
