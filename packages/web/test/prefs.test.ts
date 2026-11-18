import { afterEach, describe, expect, it } from 'vitest';
import { MINI_BAR, MINI_LIMITS, miniSize, pipSupported } from '../src/pip';
import { DEFAULT_PREFS, DETAIL_WIDTH, loadPrefs, savePrefs, SIDEBAR_WIDTH } from '../src/prefs';

const KEY = 'agent-office:prefs:v1';

function stubStorage(initial?: unknown): Map<string, string> {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(KEY, JSON.stringify(initial));
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    },
  };
  return data;
}

describe('preferências da interface', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('usa os padrões sem armazenamento ou com dados inválidos', () => {
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
    stubStorage('lixo');
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('lembra do modo pato, que começa desligado', () => {
    const data = stubStorage();
    expect(loadPrefs().duck).toBe(false);
    savePrefs({ ...DEFAULT_PREFS, duck: true });
    expect(loadPrefs().duck).toBe(true);
    data.set(KEY, JSON.stringify({ duck: 'quack' }));
    expect(loadPrefs().duck).toBe(false);
  });

  it('mini mapa: começa pequeno, lembra do tamanho e respeita os limites', () => {
    const data = stubStorage();
    const small = miniSize('p');
    expect(loadPrefs()).toMatchObject({ miniWidth: small.width, miniHeight: small.height });

    savePrefs({ ...DEFAULT_PREFS, miniWidth: 524, miniHeight: 478 });
    expect(loadPrefs()).toMatchObject({ miniWidth: 524, miniHeight: 478 });

    data.set(KEY, JSON.stringify({ miniWidth: 10, miniHeight: 99999 }));
    expect(loadPrefs()).toMatchObject({ miniWidth: MINI_LIMITS.minWidth, miniHeight: MINI_LIMITS.maxHeight });
  });

  it('os tamanhos do mini mapa mostram o escritório inteiro, mais a barra de status', () => {
    // escritório de 704×608 px, com meio tile de parede cortado de cada lado
    expect(miniSize('p')).toEqual({ width: 352, height: 304 + MINI_BAR });
    expect(miniSize('m')).toEqual({ width: 524, height: 452 + MINI_BAR });
    expect(miniSize('g')).toEqual({ width: 696, height: 600 + MINI_BAR });
    // sem navegador (ou sem a API), o botão avisa em vez de tentar abrir
    expect(pipSupported()).toBe(false);
    (globalThis as { window?: unknown }).window = { documentPictureInPicture: { requestWindow: () => undefined } };
    expect(pipSupported()).toBe(true);
  });

  it('guarda e limita a largura dos painéis laterais', () => {
    const data = stubStorage();
    savePrefs({ ...DEFAULT_PREFS, sidebarWidth: 340, detailWidth: 480 });
    expect(loadPrefs()).toMatchObject({ sidebarWidth: 340, detailWidth: 480 });

    data.set(KEY, JSON.stringify({ sidebarWidth: 5, detailWidth: 99999 }));
    expect(loadPrefs()).toMatchObject({ sidebarWidth: SIDEBAR_WIDTH.min, detailWidth: DETAIL_WIDTH.max });

    data.set(KEY, JSON.stringify({ sidebarWidth: 'x' }));
    expect(loadPrefs()).toMatchObject({ sidebarWidth: SIDEBAR_WIDTH.default, detailWidth: DETAIL_WIDTH.default });
  });
});
