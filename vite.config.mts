import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { defineConfig, type Plugin } from 'vite';

/** The colour the editor draws its own icons in, on light and on dark themes. */
const INK = { light: '#424242', dark: '#C5C5C5' } as const;
const KINDS = ['scanning', 'answering', 'deliberating'] as const;

/**
 * Write each loader icon once per theme.
 *
 * The tree draws an icon file as an image, and an image has no inherited text colour for
 * `currentColor` to take — it comes out black, invisible on a dark theme. So the art is kept
 * in one file per loader and the themed copies are generated here, rather than written into
 * a storage folder at runtime: they ship inside the extension, where the editor is happy to
 * serve them and they exist before the first tree row is ever drawn.
 */
function themedLoaders(): Plugin {
  return {
    name: 'jury-themed-loaders',
    async closeBundle() {
      const out = 'dist/loaders';
      await mkdir(out, { recursive: true });
      for (const kind of KINDS) {
        const source = await readFile(`media/jury-${kind}.svg`, 'utf8');
        for (const theme of ['light', 'dark'] as const) {
          await writeFile(`${out}/jury-${kind}-${theme}.svg`, source.replaceAll('currentColor', INK[theme]));
        }
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const production = mode === 'production';

  return {
    plugins: [themedLoaders()],
    build: {
      ssr: 'src/extension.ts',
      outDir: 'dist',
      target: 'node20',
      sourcemap: !production,
      minify: production,
      rolldownOptions: {
        external: ['vscode'],
        output: { format: 'cjs', entryFileNames: 'extension.js' },
      },
    },
    ssr: { noExternal: true },
  };
});
