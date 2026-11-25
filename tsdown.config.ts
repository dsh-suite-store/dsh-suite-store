/**
 * The browser half's bundle, in the shape the host's module loader expects.
 *
 * A client plugin is not an ES module: it is a closure factory that the
 * loader calls through `window.__ModuleLoader__.load({ id, factory })`, and
 * the `require` it passes is the host's own module table. Three consequences
 * drive this file:
 *
 * - **React comes from the table.** `react` and `react/jsx-runtime` are the
 *   only two the bundle actually imports, and they are externals: inlining them
 *   would give the page a second React and every hook in it would see a
 *   dispatcher the host's reconciler never installed. `CLIENT_EXTERNALS` also
 *   lists `react-dom` and the primitives package because the loader's table can
 *   answer them — but nothing statically imports either (`primitives.ts` reads
 *   the host module through `globalThis.require`), and
 *   `scripts/check-client-banner.mjs` only permits the two `react` entries, so
 *   listing them here documents the table rather than the bundle.
 * - **Everything else is inlined.** `tsdown` externalises package
 *   dependencies by default, and a `require('x')` the table cannot answer is
 *   a guaranteed runtime throw — so `noExternal` inlines everything that is
 *   not one of the seed entries above.
 * - **CSS Modules compile here.** `lightningcss` turns `x.module.css` into
 *   the hashed class map the components import, and the stylesheet text
 *   rides in the factory as a `<style data-plugin>` tag the loader removes
 *   when the plugin unloads. The filename handed to lightningcss is
 *   repo-relative with forward slashes: an absolute path would make
 *   `[hash]` a fingerprint of the checkout location, so the same commit
 *   would build differently on two machines.
 */

import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve as resolvePath } from 'node:path'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'

/** The module-table id the host keys this bundle by. */
const id = 'dsh-suite-store'

/**
 * Externals the loader's module table can answer. Nothing else may be
 * external; see the header.
 */
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives']

/**
 * A virtual id that keeps stylesheets away from tsdown's own CSS pipeline.
 *
 * The suffix must not be `.css`: tsdown's guard matches ids ending in `.css`
 * and would try to hand the virtual module to its CSS plugin instead.
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-suite-store-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  // `package.json`'s "./client" export points here, so the bundle lands
  // exactly where the loader looks for it.
  outDir: 'client',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  // Declarations come from tsc into lib/types; a rollup-generated .d.cts here
  // would wrap the banner/footer and fail to parse.
  dts: false,
  // No sourcemap: the artifact is committed, and a single-line map turns
  // every concurrent front-end change into a whole-file conflict while
  // buying almost nothing — the bundle is unminified and its stack frames
  // already name real functions.
  sourcemap: false,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  noExternal: (source: string) => (CLIENT_EXTERNALS.includes(source) ? undefined : true),
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
    'import.meta.env': JSON.stringify({ MODE: 'production' }),
  },
  plugins: [{
    name: 'dsh-suite-store-css-modules',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const absolute = importer !== undefined ? resolvePath(dirname(importer), source) : source
      return CSS_VIRTUAL_PREFIX + absolute + CSS_VIRTUAL_SUFFIX
    },
    async load(this: { addWatchFile(file: string): void }, virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      // The virtual id otherwise hides the real file from the watch graph.
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: relative(process.cwd(), fileId).split('\\').join('/'),
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
        // Without targets, lightningcss collapses the hand-written
        // `backdrop-filter` + `-webkit-backdrop-filter` pair down to the
        // prefixed form only, which drops Firefox. Targets keep both.
        targets: { chrome: 90 << 16, firefox: 100 << 16, safari: 13 << 16, edge: 90 << 16 },
      })
      const classMap: Record<string, string> = {}
      for (const [local, exported] of Object.entries(cssExports ?? {})) classMap[local] = exported.name
      // One <style> per module file, idempotent under re-evaluation: the
      // loader may run a factory twice in a session and a duplicated sheet
      // would double every rule.
      //
      // The id is the REPO-RELATIVE path, not the basename: two stylesheets
      // named `list.module.css` in different folders produced the same id, and
      // the idempotency guard below then found the first tag and silently
      // skipped the second, so its rules never reached the page. The relative
      // path is also what lightningcss is given as `filename`, so the id and
      // the class hash are derived from the same identity.
      const tagId = `${id}/${relative(process.cwd(), fileId).split('\\').join('/')}`
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
        '  const tag = document.createElement(\'style\');',
        `  tag.dataset.plugin = ${JSON.stringify(id)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        // `document.head` is null while the document is still parsing, and a
        // client plugin can be activated at that point: dereferencing it threw
        // and lost the whole stylesheet. `documentElement` always exists once
        // there is a document at all.
        '  (document.head ?? document.documentElement).appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    // The three lines the loader reads: it parses the id out of the banner
    // and calls the factory with its own `require`.
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
