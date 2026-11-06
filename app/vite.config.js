import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  plugins: [viteSingleFile()],
  assetsInclude: ['**/*.glb'],
  build: { outDir: 'dist', assetsInlineLimit: 100000000, chunkSizeWarningLimit: 5000 },
});
