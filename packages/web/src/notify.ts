import type { SessionState } from '@agent-office/server/schema';
import { makeCanvas } from './game/art/painter';
import { portraitFor } from './game/art/characterDraw';
import { variantFor } from './game/variant';
import { AGENT_LABEL } from './i18n';
import type { AttentionKind } from './store';

/** Notificações do sistema, título da aba e favicon. */

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationsGranted(): boolean {
  return notificationsSupported() && Notification.permission === 'granted';
}

export type PermissionResult = 'granted' | 'denied' | 'unsupported';

/** Pede permissão — chamado apenas quando o usuário liga o botão. */
export async function requestNotifications(): Promise<PermissionResult> {
  if (!notificationsSupported()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const result = await Notification.requestPermission();
    return result === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

const TITLES: Record<AttentionKind, (label: string) => string> = {
  waiting_input: (label) => `${label} está aguardando você`,
  permission_wait: (label) => `${label} pede permissão`,
  done: (label) => `${label} concluiu`,
};

export function showNotification(session: SessionState, kind: AttentionKind, onClick: () => void): void {
  if (!notificationsGranted()) return;
  try {
    const parts = [AGENT_LABEL[session.agent], session.project].filter(Boolean);
    if (kind === 'permission_wait' && session.toolName) parts.push(`quer usar ${session.toolName}`);
    const n = new Notification(TITLES[kind](session.label), {
      body: parts.join(' · '),
      tag: `agent-office:${session.key}`,
      icon: portraitFor(variantFor(session.key, session.agent, session.parentKey)),
    });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  } catch {
    /* alguns navegadores só permitem via service worker: ignora */
  }
}

let faviconBase: HTMLCanvasElement | null = null;
let lastFavicon = '';

/** Favicon gerado em código, com um ponto amarelo quando alguém espera resposta. */
export function setFavicon(attention: boolean): void {
  const id = attention ? 'a' : 'n';
  if (id === lastFavicon) return;
  lastFavicon = id;
  if (!faviconBase) {
    const img = new Image();
    img.onload = () => {
      const { canvas, ctx } = makeCanvas(32, 32);
      ctx.fillStyle = '#1b1f2a';
      ctx.fillRect(0, 0, 32, 32);
      ctx.drawImage(img, 0, 0, 16, 16, 0, 0, 32, 32);
      faviconBase = canvas;
      lastFavicon = '';
      setFavicon(attention);
    };
    img.src = portraitFor(variantFor('agent-office', 'claude'));
    return;
  }
  const { canvas, ctx } = makeCanvas(32, 32);
  ctx.drawImage(faviconBase, 0, 0);
  if (attention) {
    ctx.fillStyle = '#1b1f2a';
    ctx.fillRect(18, 0, 14, 14);
    ctx.fillStyle = '#ffd84a';
    ctx.fillRect(20, 2, 10, 10);
  }
  const link = document.getElementById('favicon');
  if (link instanceof HTMLLinkElement) {
    link.type = 'image/png';
    link.href = canvas.toDataURL('image/png');
  }
}

export function setTitle(attention: number): void {
  const title = attention > 0 ? `(${attention}) agent-office` : 'agent-office';
  if (document.title !== title) document.title = title;
}
