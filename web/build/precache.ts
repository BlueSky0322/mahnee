import type { Plugin, Rollup } from 'vite';

// The list of built files the service worker (web/public/sw.js) keeps on the device, so
// the app starts offline and what it offers offline works there too: sharing a split as
// an image, and exporting it as a PDF or CSV, load their code only when first used.

/** Where the build writes the list; PRECACHE_LIST in web/public/sw.js reads it */
export const PRECACHE_FILE = 'precache.json';

/** A built chunk, as far as choosing what to keep needs */
export interface BuiltChunk {
  fileName: string;
  isEntry: boolean;
  /** Chunks it imports up front */
  imports: string[];
  /** Its styles and the other files it names */
  files: string[];
  /** The source modules bundled into it */
  moduleIds: string[];
}

/**
 * Every file the app needs offline, as addresses: the entry with what it imports and its
 * styles, and each chunk the app's own code loads later (`lazyModules`, the modules it
 * imports with import()) with what that imports. Chunks only a library loads for itself,
 * such as jsPDF's optional html2canvas, canvg and DOMPurify, are left out: the app never
 * asks for them.
 */
export function filesToKeep(chunks: BuiltChunk[], lazyModules: Iterable<string>): string[] {
  const byName = new Map(chunks.map((c) => [c.fileName, c]));
  const keep = new Set<string>();
  const add = (chunk: BuiltChunk) => {
    if (keep.has(chunk.fileName)) return;
    keep.add(chunk.fileName);
    for (const file of chunk.files) keep.add(file);
    for (const name of chunk.imports) {
      const imported = byName.get(name);
      if (imported) add(imported);
    }
  };
  const lazy = new Set(lazyModules);
  for (const chunk of chunks) {
    if (chunk.isEntry || chunk.moduleIds.some((id) => lazy.has(id))) add(chunk);
  }
  return [...keep].sort().map((file) => `/${file}`);
}

/** The app's own source, rather than a package or something the bundler made up */
const isAppModule = (id: string) => !id.startsWith('\0') && !id.includes('/node_modules/');

/** Writes the list into the build, beside index.html */
export function precacheList(): Plugin {
  return {
    name: 'mahnee-precache-list',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle)
        .filter((file): file is Rollup.OutputChunk => file.type === 'chunk')
        .map(
          (chunk): BuiltChunk => ({
            fileName: chunk.fileName,
            isEntry: chunk.isEntry,
            imports: chunk.imports,
            files: [
              ...(chunk.viteMetadata?.importedCss ?? []),
              ...(chunk.viteMetadata?.importedAssets ?? []),
            ],
            moduleIds: chunk.moduleIds,
          }),
        );
      const lazyModules = [...this.getModuleIds()]
        .filter(isAppModule)
        .flatMap((id) => this.getModuleInfo(id)?.dynamicallyImportedIds ?? []);
      this.emitFile({
        type: 'asset',
        fileName: PRECACHE_FILE,
        source: JSON.stringify(filesToKeep(chunks, lazyModules)),
      });
    },
  };
}
