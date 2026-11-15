import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

export interface ShellFile {
  /** Caminho relativo à saída do build, com `/`. */
  path: string;
  content: Uint8Array;
}

/** O que a janela instalada precisa para abrir sem servidor: página, JS e CSS. */
export function precacheUrls(files: readonly ShellFile[]): string[] {
  return files
    .map((f) => f.path)
    .filter((p) => p !== 'sw.js' && !p.startsWith('icons/') && !p.endsWith('.map'))
    .map((p) => (p === 'index.html' ? '/' : `/${p}`))
    .sort();
}

/** Muda sempre que qualquer arquivo publicado muda — é o que troca o cache. */
export function shellVersion(files: readonly ShellFile[]): string {
  const hash = createHash('sha256');
  for (const f of [...files].filter((f) => f.path !== 'sw.js').sort((a, b) => (a.path < b.path ? -1 : 1))) {
    hash.update(f.path).update('\0').update(f.content).update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}

export function fillServiceWorker(template: string, files: readonly ShellFile[]): string {
  if (!template.includes("'__SW_VERSION__'") || !template.includes("['__SW_PRECACHE__']")) {
    throw new Error('sw.js sem os marcadores __SW_VERSION__ / __SW_PRECACHE__');
  }
  return template
    .replace("'__SW_VERSION__'", JSON.stringify(shellVersion(files)))
    .replace("['__SW_PRECACHE__']", JSON.stringify(precacheUrls(files)));
}

function walk(dir: string, root = dir): ShellFile[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, root);
    return [{ path: relative(root, full).split(sep).join('/'), content: readFileSync(full) }];
  });
}

/** Depois do build, preenche o `sw.js` com a lista de arquivos e a versão. */
export function serviceWorkerPlugin(): Plugin {
  let outDir = '';
  return {
    name: 'agent-office:service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const target = join(outDir, 'sw.js');
      writeFileSync(target, fillServiceWorker(readFileSync(target, 'utf8'), walk(outDir)));
    },
  };
}
