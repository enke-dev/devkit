import { nodeLibrary } from '@enke.dev/lint/eslint/presets/node-library';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['dist/']),
  ...nodeLibrary,
  {
    name: 'devkit/ignored-rejections',
    // The rule lives in a plugin, and flat config wants the plugin named here too.
    plugins: { '@typescript-eslint': tseslint.plugin },
    // `.catch(() => {})` is how "this failure is expected and nothing depends on
    // it" is written — a page that closed mid-call, a browser already gone.
    // Named and method bodies are still checked.
    rules: { '@typescript-eslint/no-empty-function': ['error', { allow: ['arrowFunctions'] }] },
  },
]);
