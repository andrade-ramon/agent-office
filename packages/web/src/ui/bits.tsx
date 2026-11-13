import { memo, useEffect, useState, type ReactElement } from 'react';
import type { SessionState, SessionStatus } from '@agent-office/server/schema';
import { portraitFor } from '../game/art/characterDraw';
import { variantFor } from '../game/variant';
import { STATUS_LABEL } from '../i18n';

/** Retrato pixelado do personagem (mesma aparência da cena). */
export const Avatar = memo(function Avatar({
  session,
  size = 32,
}: {
  session: Pick<SessionState, 'key' | 'agent' | 'parentKey'>;
  size?: number;
}): ReactElement {
  const src = portraitFor(variantFor(session.key, session.agent, session.parentKey));
  return <img className={`avatar avatar-${session.agent}`} src={src} width={size} height={size} alt="" draggable={false} />;
});

export function StatusChip({ status }: { status: SessionStatus }): ReactElement {
  return (
    <span className={`chip chip-${status}`}>
      <i className="chip-dot" />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Reexecuta o componente a cada `ms` e devolve `Date.now()`. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}
