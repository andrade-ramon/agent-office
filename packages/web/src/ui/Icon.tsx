import { memo, type ReactElement } from 'react';
import { ICONS, type IconName } from '../game/art/icons';

interface Props {
  name: IconName;
  /** Altura em pixels CSS. */
  size?: number;
  className?: string;
}

/** Ícone pixelado (os mesmos bitmaps dos balões da cena), renderizado em SVG. */
export const Icon = memo(function Icon({ name, size = 14, className }: Props): ReactElement {
  const rows = ICONS[name];
  const h = rows.length;
  const w = rows[0]!.length;
  const rects: ReactElement[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== 'X') {
        x++;
        continue;
      }
      let end = x;
      while (end < row.length && row[end] === 'X') end++;
      rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={end - x} height={1} />);
      x = end;
    }
  });
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={(size * w) / h}
      height={size}
      viewBox={`0 0 ${w} ${h}`}
      shapeRendering="crispEdges"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {rects}
    </svg>
  );
});
