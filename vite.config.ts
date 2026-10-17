import i18n from '@intlify/unplugin-vue-i18n/vite';
import vue from '@vitejs/plugin-vue';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { patchEngine } from './patch/engine.ts';

const client = (file: string) => path.resolve(import.meta.dirname, 'client', file);
const engine = (file: string) => readFile(path.resolve(import.meta.dirname, 'engine', file));

// The glue spawns its threads from its own URL and the engine runs the wasm next to it: both stay out of the bundle, in artifacts/.
const artifacts: Plugin = {
  name: 'bo1z-engine',
  async generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'artifacts/KisakBlack-web.mjs', source: await engine('KisakBlack-web.mjs') });
    this.emitFile({ type: 'asset', fileName: 'artifacts/KisakBlack-web.wasm', source: patchEngine(await engine('KisakBlack-web.wasm')) });
  },
};

// The glue imports ../kbnet.js from artifacts/: this entry keeps that name and its exports.
export default defineConfig({
  root: 'client',
  // Translations compiled at build time, so the site ships without vue-i18n's message compiler.
  plugins: [vue(), i18n({ include: client('i18n/{en,fr}.ts'), fullInstall: false, dropMessageCompiler: true }), artifacts],
  base: './',
    worker: { format: 'es' },
  // The i18n plugin sets vue-i18n's other build flags, but this one only for webpack.
  define: { __INTLIFY_PROD_DEVTOOLS__: false },
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2024',
    rolldownOptions: {
      input: { index: client('index.html'), kbnet: client('net/engine.ts') },
      preserveEntrySignatures: 'exports-only',
      output: { entryFileNames: chunk => (chunk.name === 'kbnet' ? 'kbnet.js' : 'assets/[name]-[hash].js') },
    },
  },
});
