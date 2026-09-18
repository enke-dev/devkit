import { frontend } from '@enke.dev/lint/eslint/presets/frontend';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['dist/']),
  ...frontend,
  {
    name: 'devkit/html-formatting',
    // Prettier formats index.html, and it puts attributes on one line where they
    // fit. Leaving this rule on means the two rewrite the same file in opposite
    // directions on every run.
    rules: { 'html/attrs-newline': 'off' },
  },
  {
    name: 'devkit/ignored-rejections',
    // The rule lives in a plugin, and flat config wants the plugin named here too.
    plugins: { '@typescript-eslint': tseslint.plugin },
    // `.catch(() => {})` is how "this failure is expected and nothing depends on
    // it" is written — a pane torn down mid-navigation, a debug channel that is
    // not worth failing over. Named and method bodies are still checked.
    rules: { '@typescript-eslint/no-empty-function': ['error', { allow: ['arrowFunctions'] }] },
  },
]);
