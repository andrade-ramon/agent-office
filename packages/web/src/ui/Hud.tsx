import type { ReactElement } from 'react';
import type { IconName } from '../game/art/icons';
import { TIME_MODES, type TimeMode } from '../game/daynight';
import type { CameraInfo } from '../game/scene';
import { TIME_MODE_LABEL } from '../i18n';
import { Icon } from './Icon';

interface Props {
  camera: CameraInfo | null;
  timeMode: TimeMode;
  areas: boolean;
  labels: boolean;
  hasSelection: boolean;
  onZoom(steps: number): void;
  onFit(): void;
  onFocus(): void;
  onTimeMode(mode: TimeMode): void;
  onToggleAreas(): void;
  onToggleLabels(): void;
}

const TIME_ICON: Record<TimeMode, IconName> = {
  auto: 'clock',
  day: 'sun',
  night: 'moon',
  fast: 'cycle',
};

/** Controles sobre a cena: zoom, câmera, hora do dia e legenda. */
export function Hud(p: Props): ReactElement {
  const zoom = p.camera ? Math.round(p.camera.zoom * 100) : 100;
  return (
    <>
      <div className="hud hud-left">
        <div className="seg seg-icons" role="group" aria-label="Hora do dia">
          {TIME_MODES.map((m) => (
            <button
              key={m}
              type="button"
              className={p.timeMode === m ? 'on' : ''}
              onClick={() => p.onTimeMode(m)}
              title={TIME_MODE_LABEL[m]}
              aria-pressed={p.timeMode === m}
            >
              <Icon name={TIME_ICON[m]} size={12} />
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`tool ${p.areas ? 'on' : ''}`}
          onClick={p.onToggleAreas}
          title="Legenda das áreas (A)"
          aria-pressed={p.areas}
        >
          <Icon name="help" size={12} />
        </button>
        <button
          type="button"
          className={`tool hud-labels ${p.labels ? 'on' : ''}`}
          onClick={p.onToggleLabels}
          title="Mostrar nomes (L)"
          aria-pressed={p.labels}
        >
          <Icon name="tag" size={12} />
        </button>
      </div>

      <div className="hud hud-right">
        {p.hasSelection && (
          <button
            type="button"
            className={`tool wide ${p.camera?.mode === 'follow' ? 'on' : ''}`}
            onClick={p.onFocus}
            title="Centralizar e seguir o personagem selecionado"
          >
            <Icon name="target" size={12} />
            Focar
          </button>
        )}
        <button type="button" className="tool" onClick={p.onFit} title="Ver o escritório inteiro (0)">
          <Icon name="fit" size={12} />
        </button>
        <div className="zoom">
          <button
            type="button"
            className="tool"
            onClick={() => p.onZoom(-1)}
            disabled={p.camera ? !p.camera.canZoomOut : false}
            title="Afastar (−)"
            aria-label="Afastar"
          >
            <Icon name="minus" size={12} />
          </button>
          <span className="zoom-value" title="Zoom">
            {zoom}%
          </span>
          <button
            type="button"
            className="tool"
            onClick={() => p.onZoom(1)}
            disabled={p.camera ? !p.camera.canZoomIn : false}
            title="Aproximar (+)"
            aria-label="Aproximar"
          >
            <Icon name="plus" size={12} />
          </button>
        </div>
      </div>
    </>
  );
}
