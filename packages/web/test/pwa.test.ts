import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fillServiceWorker, precacheUrls, shellVersion, type ShellFile } from '../sw-plugin';

const pub = (path: string): string => fileURLToPath(new URL(`../public/${path}`, import.meta.url));
const file = (path: string, text = path): ShellFile => ({ path, content: new TextEncoder().encode(text) });

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}

describe('manifest do web app', () => {
  const manifest = JSON.parse(readFileSync(pub('manifest.webmanifest'), 'utf8')) as {
    name: string;
    start_url: string;
    display: string;
    icons: ManifestIcon[];
  };

  it('tem o mínimo para ser instalável', () => {
    expect(manifest.name).toBe('Agent Office');
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
    const any = manifest.icons.filter((i) => i.purpose === 'any').map((i) => i.sizes);
    expect(any).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });

  it('cada ícone existe e tem o tamanho declarado', () => {
    for (const icon of manifest.icons) {
      const png = readFileSync(pub(icon.src.slice(1)));
      expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
      // IHDR: largura e altura logo após a assinatura e o cabeçalho do bloco.
      expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(icon.sizes);
    }
  });

  it('o index.html aponta para o manifest e para o ícone da Apple', () => {
    const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('rel="apple-touch-icon" href="/icons/apple-touch-icon.png"');
    expect(existsSync(pub('icons/apple-touch-icon.png'))).toBe(true);
  });
});

describe('service worker', () => {
  const template = readFileSync(pub('sw.js'), 'utf8');
  const files = [file('index.html'), file('assets/app-abc.js'), file('assets/app-abc.css'), file('sw.js'), file('icons/icon-192.png'), file('manifest.webmanifest')];

  it('guarda a casca do app, sem o próprio sw.js nem os ícones', () => {
    expect(precacheUrls(files)).toEqual(['/', '/assets/app-abc.css', '/assets/app-abc.js', '/manifest.webmanifest']);
  });

  it('a versão muda quando qualquer arquivo publicado muda, mas não com o sw.js', () => {
    const v = shellVersion(files);
    expect(shellVersion([...files].reverse())).toBe(v);
    expect(shellVersion(files.map((f) => (f.path === 'sw.js' ? file('sw.js', 'outro') : f)))).toBe(v);
    expect(shellVersion(files.map((f) => (f.path === 'index.html' ? file('index.html', 'novo') : f)))).not.toBe(v);
  });

  it('preenche os marcadores do sw.js', () => {
    const out = fillServiceWorker(template, files);
    expect(out).not.toContain('__SW_');
    expect(out).toContain(`const VERSION = "${shellVersion(files)}";`);
    expect(out).toContain('const PRECACHE = ["/","/assets/app-abc.css"');
    expect(() => fillServiceWorker('sem marcadores', files)).toThrow();
  });

  it('nunca intercepta a API, os eventos nem o WebSocket', () => {
    expect(template).toContain("path.startsWith('/api/') || path.startsWith('/events') || path.startsWith('/ws')");
  });
});
