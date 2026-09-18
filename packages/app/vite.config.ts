import { createRequire } from 'node:module';

import { defineConfig } from 'vite';
import litCss from 'vite-plugin-lit-css';

import { litCssWatch } from './vite-watch-lit-css.plugin.js';

const require = createRequire(import.meta.url);
const lit = require.resolve('lit');
const litDecorators = require.resolve('lit/decorators.js');

// Tauri serves the frontend from a fixed port and needs a stable, non-obfuscated
// error surface, so the dev server fails loudly rather than hopping ports.
export default defineConfig({
  clearScreen: false,
  // Component styles are real CSS files, imported as lit `CSSResult`s. The
  // global stylesheet is excluded: it is loaded as a stylesheet, not inlined
  // into a shadow root.
  plugins: [
    litCss({ exclude: ['src/styles/**/*.css'] }),
    // Component styles are adopted into shadow roots, which Vite's own stylesheet
    // swap never reaches; this re-evaluates the components that imported them.
    litCssWatch(),
  ],
  resolve: {
    // Phosphor's icon elements are Lit components, and the package ships its own
    // copy of Lit rather than importing the one it declares as a dependency.
    // Left alone the bundle carries two Lit runtimes and says so in the console;
    // these point its imports back at ours. Everything it reaches for is part of
    // `lit`'s own public surface, so the substitution is exact.
    alias: [
      {
        find: /^.*[\\/]\.pnpm[\\/]@lit_reactive-element@[^\\/]+[\\/].*[\\/]decorators[\\/].*\.mjs$/,
        replacement: litDecorators,
      },
      {
        find: /^.*[\\/]\.pnpm[\\/](?:lit-html|lit-element|@lit_reactive-element)@[^\\/]+[\\/].*\.mjs$/,
        replacement: lit,
      },
    ],
  },
  server: {
    port: 1430,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**', '**/packages/sidecar/dist/**'],
    },
  },
  build: {
    target: 'es2023',
    sourcemap: true,
  },
});
