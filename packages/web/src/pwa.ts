/** Web app instalável: service worker, convite de instalação e selo no ícone do Dock. */

/** Só no build de produção — em `vite dev` o service worker atrapalharia o HMR. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

/** Evento do Chrome/Edge que permite abrir o diálogo de instalação por um botão. */
interface InstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let pending: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function changed(): void {
  for (const fn of listeners) fn();
}

/** Deve rodar cedo: o navegador dispara `beforeinstallprompt` logo após o carregamento. */
export function watchInstall(): void {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    pending = event as InstallPromptEvent;
    changed();
  });
  window.addEventListener('appinstalled', () => {
    pending = null;
    changed();
  });
}

export function subscribeInstall(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** true quando o navegador oferece instalar (ainda não instalado e suportado). */
export function canInstall(): boolean {
  return pending !== null;
}

/** Abre o diálogo do navegador; devolve true se a pessoa aceitou. */
export async function promptInstall(): Promise<boolean> {
  const event = pending;
  if (!event) return false;
  pending = null;
  changed();
  try {
    await event.prompt();
    return (await event.userChoice).outcome === 'accepted';
  } catch {
    return false;
  }
}

type BadgeNavigator = Navigator & {
  setAppBadge?(count?: number): Promise<void>;
  clearAppBadge?(): Promise<void>;
};

/** Número no ícone do Dock (app instalado): quantas sessões esperam você. */
export function setAppBadge(count: number): void {
  const nav = navigator as BadgeNavigator;
  try {
    const done = count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.();
    done?.catch(() => undefined);
  } catch {
    /* sem suporte: ignora */
  }
}
