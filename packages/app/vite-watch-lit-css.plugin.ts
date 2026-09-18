import type { EnvironmentModuleNode, Plugin } from 'vite';

/**
 * Make component stylesheets hot-reload.
 *
 * `vite-plugin-lit-css` turns a `.css` import into a `CSSResult` living in the
 * JS module graph. Vite still treats the file as a stylesheet and hot-swaps it
 * the usual way — which updates nothing, because the styles are adopted into a
 * shadow root by the component that imported them, and that component is never
 * re-evaluated. Editing a component's CSS appears to do nothing until a manual
 * reload.
 *
 * So the importers are invalidated alongside the stylesheet and handed back as
 * the modules to update: the component re-evaluates, builds a new `CSSResult`
 * and re-adopts it. Nothing accepts the update, so this lands as a page reload
 * rather than a swap in place — which is the point, since a reload is what was
 * being done by hand.
 *
 * Only the stylesheets that were taken over this way are touched. Which those
 * are is read off the compiled module rather than matched against paths, so the
 * two plugins cannot fall out of step over which files the lit transform claims.
 */
export function litCssWatch(): Plugin {
  /**
   * Whether each stylesheet still updates itself, by file.
   *
   * Vite compiles a stylesheet into a module that accepts its own updates;
   * whatever replaces that — here, a module exporting a `CSSResult` — cannot.
   * The answer is taken while the compiled code is in hand: by the time the file
   * changes, Vite has dropped the module's transform result, and the node's own
   * `isSelfAccepting` is no use either, being set from the request being a
   * stylesheet rather than from what a plugin left behind.
   */
  const updatesItself = new Map<string, boolean>();
  const fileOf = (id: string) => id.split('?')[0] ?? id;

  return {
    name: 'watch-lit-css',
    enforce: 'post',

    transform(code, id) {
      const file = fileOf(id);
      if (file.endsWith('.css')) {
        updatesItself.set(file, code.includes('import.meta.hot.accept'));
      }
      return null;
    },

    configureServer(server) {
      server.watcher.add('src/**/*.css');
    },

    hotUpdate(options) {
      // Adopted stylesheets exist only in a browser, and the hook runs once per
      // environment.
      if (this.environment.name !== 'client' || !options.file.endsWith('.css')) {
        return;
      }

      // A stylesheet Vite still owns updates itself; leaving it alone keeps its
      // swap in place rather than turning it into a reload.
      const stale = options.modules.filter(
        module => !updatesItself.get(module.id === null ? options.file : fileOf(module.id))
      );
      if (stale.length === 0) {
        return;
      }

      const { moduleGraph } = this.environment;
      const modulesToUpdate = stale.reduce((acc, module) => {
        moduleGraph.invalidateModule(module);
        return new Set([
          ...acc,
          ...[...module.importers].filter(importer => {
            const relevant = /\.(js|ts|jsx|tsx)$/.test(importer.url);
            if (relevant) {
              moduleGraph.invalidateModule(importer);
            }
            return relevant;
          }),
        ]);
      }, new Set<EnvironmentModuleNode>());

      return modulesToUpdate.size > 0 ? Array.from(modulesToUpdate) : stale;
    },
  };
}
