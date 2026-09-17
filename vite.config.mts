import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
  const production = mode === 'production';

  return {
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
