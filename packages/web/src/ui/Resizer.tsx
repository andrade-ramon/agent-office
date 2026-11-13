import { useCallback, useRef, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react';

interface Props {
  /** Lado do painel em que a alça fica: 'right' (painel à esquerda) ou 'left' (painel à direita). */
  edge: 'left' | 'right';
  width: number;
  min: number;
  max: number;
  defaultWidth: number;
  label: string;
  className?: string;
  onResize(width: number): void;
}

const STEP = 16;

/**
 * Alça vertical para redimensionar um painel lateral com o mouse.
 * Arrastar ajusta a largura; duplo clique volta ao padrão; setas ajustam pelo teclado.
 */
export function Resizer(p: Props): ReactElement {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const { edge, width, min, max, defaultWidth, onResize } = p;

  const clamp = useCallback((w: number) => Math.round(Math.max(min, Math.min(max, w))), [min, max]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, width };
    document.body.classList.add('resizing');
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d) return;
    const delta = e.clientX - d.x;
    onResize(clamp(d.width + (edge === 'right' ? delta : -delta)));
  };
  const end = (e: PointerEvent<HTMLDivElement>): void => {
    if (!drag.current) return;
    drag.current = null;
    document.body.classList.remove('resizing');
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const grow = edge === 'right' ? 'ArrowRight' : 'ArrowLeft';
    const shrink = edge === 'right' ? 'ArrowLeft' : 'ArrowRight';
    if (e.key === grow) onResize(clamp(width + STEP));
    else if (e.key === shrink) onResize(clamp(width - STEP));
    else if (e.key === 'Home') onResize(clamp(defaultWidth));
    else return;
    e.preventDefault();
  };

  return (
    <div
      className={`resizer resizer-${edge} ${p.className ?? ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={p.label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      title={`${p.label} — arraste para ajustar; duplo clique restaura`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onResize(clamp(defaultWidth))}
      onKeyDown={onKeyDown}
    />
  );
}
