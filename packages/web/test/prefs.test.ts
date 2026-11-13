import { afterEach, describe, expect, it } from 'vitest';
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
