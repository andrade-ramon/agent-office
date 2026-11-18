import { MAP_H, MAP_W, TILE } from './game/layout';

/**
 * Mini mapa em janela flutuante (Document Picture-in-Picture): uma janela
 * pequena, sempre por cima das outras, que continua mostrando o escritório
 * enquanto você trabalha em outro app. Disponível no Chrome e no Edge (116+).
 *
 * O navegador só abre essa janela a partir de um clique ou tecla — não há como
 * abri-la sozinha quando a janela principal perde o foco. Depois de aberta, ela
 * fica até ser fechada.
 */

interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window & typeof globalThis>;
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPicture;
  }
}

/** Altura da barra de status do mini mapa (px). */
export const MINI_BAR = 26;
const MARGIN = 8;

export type MiniSize = 'p' | 'm' | 'g';

/** Zoom do mapa em cada tamanho: 0,5 é o menor em que tudo aparece (nítido em telas de alta densidade). */
const ZOOM: Record<MiniSize, number> = { p: 0.5, m: 0.75, g: 1 };

/** Tamanho da janela (área útil) para o escritório inteiro caber no zoom daquele tamanho. */
export function miniSize(size: MiniSize): { width: number; height: number } {
  const z = ZOOM[size];
  return {
    width: Math.round((MAP_W * TILE - TILE) * z) + MARGIN,
    height: Math.round((MAP_H * TILE - TILE) * z) + MARGIN + MINI_BAR,
  };
}

export const MINI_LIMITS = { minWidth: 240, minHeight: 180, maxWidth: 1600, maxHeight: 1400 } as const;

export function pipSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.documentPictureInPicture?.requestWindow === 'function';
}

/** Leva para a janela flutuante os estilos da página (ela nasce como um documento vazio). */
function copyStyles(from: Document, to: Document): void {
  for (const sheet of Array.from(from.styleSheets)) {
    try {
      const style = to.createElement('style');
      style.textContent = Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n');
      to.head.appendChild(style);
    } catch {
      // Folha de outra origem: as regras não podem ser lidas, então aponta para o mesmo arquivo.
      if (!sheet.href) continue;
      const link = to.createElement('link');
      link.rel = 'stylesheet';
      link.href = sheet.href;
      to.head.appendChild(link);
    }
  }
}

/** Abre a janela flutuante. Precisa ser chamada dentro de um clique ou tecla. */
export async function openMiniWindow(size: { width: number; height: number }): Promise<Window & typeof globalThis> {
  const api = window.documentPictureInPicture;
  if (!api) throw new Error('sem suporte a janela flutuante');
  const win = await api.requestWindow(size);
  copyStyles(document, win.document);
  win.document.title = 'Agent Office';
  win.document.documentElement.lang = document.documentElement.lang || 'pt-BR';
  win.document.body.classList.add('mini-window');
  return win;
}

/** Muda o tamanho da janela flutuante (área útil). Só funciona dentro de um clique nela. */
export function resizeMiniWindow(win: Window, size: { width: number; height: number }): void {
  try {
    win.resizeTo(size.width + (win.outerWidth - win.innerWidth), size.height + (win.outerHeight - win.innerHeight));
  } catch {
    /* o navegador recusou (sem clique recente): o usuário ainda pode arrastar a borda */
  }
}
