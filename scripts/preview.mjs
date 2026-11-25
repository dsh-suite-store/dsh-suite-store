/**
 * Render the store page outside the host, for visual review.
 *
 * The host's Web UI needs a running DSH profile to show this page, which makes
 * every visual iteration a restart. This script builds a throwaway static page
 * that imports the same `client/client.js` the host loads, stubs the module
 * loader so the bundle registers normally, and feeds it the real catalog from
 * `data/`. The result is the actual component tree rendered by the actual
 * stylesheet — not a mock-up — in a plain browser.
 *
 * The theme tokens are copied from the host's theme bundle so colours resolve
 * exactly as they do in the app. Without them every `var(--dsw-*)` would fall
 * back to its literal, which is the light theme only; copying them is what
 * makes a dark-mode screenshot mean something.
 *
 * Usage:
 *   node scripts/preview.mjs <out.html> [--catalog <index.json>]
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE = resolve(HERE, '..')
const ASAR = 'D:/Develop/Program/dsh/env/resources/app.asar'
const THEME = '/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'

/**
 * The host's theme, split into its two sets.
 *
 * The bundle declares the light palette on `body` and the dark one on
 * `body[data-ds-dark-theme]`. Reading both into one `:root` block — as this
 * script used to — lets the dark values overwrite the light ones, so every
 * screenshot came out dark regardless of what the page asked for. Keeping the
 * two sets separate is what makes a light-mode screenshot mean anything.
 *
 * @returns the two declaration blocks and the host's own dark selector.
 */
function themeSets() {
  // The asar path must be passed through unchanged, so it is read by a child
  // node process rather than by a shell that would rewrite `/dsh/...`.
  const reader = join(HERE, 'asar-read.mjs')
  const empty = { light: '', dark: '', selector: 'body[data-ds-dark-theme]' }
  try {
    const text = execFileSync(process.execPath, [reader, ASAR, 'cat', THEME], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    const light = new Map()
    const dark = new Map()
    for (const [, selectorRaw, block] of text.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      const selector = String(selectorRaw).trim()
      const target = selector.includes('data-ds-dark-theme')
        ? dark
        : ['body', ':root', ''].includes(selector)
          ? light
          : undefined
      if (target === undefined) continue
      for (const match of String(block).matchAll(/(--dsw-[a-z0-9-]+)\s*:\s*([^;{}]+)/gu)) {
        target.set(match[1], match[2].trim())
      }
    }
    const render = (map) => [...map].map(([name, value]) => `${name}: ${value};`).join('\n')
    return { light: render(light), dark: render(dark), selector: 'body[data-ds-dark-theme]' }
  } catch {
    // A preview that renders with fallback colours still beats no preview.
    console.warn('theme: could not read the host theme; preview uses CSS fallbacks')
    return empty
  }
}

/**
 * The command line, parsed once.
 *
 * `argv[2]` used to be taken as the output path regardless of flags, so
 * `preview.mjs --dark` wrote a file literally named `--dark`; and `--catalog`
 * without a value made `resolve(undefined)` throw a raw TypeError.
 *
 * @returns the resolved options.
 */
function parseArguments() {
  const argv = process.argv.slice(2)
  const flag = (name) => argv.indexOf(name)
  const valueOf = (name) => {
    const at = flag(name)
    if (at === -1) return undefined
    const value = argv[at + 1]
    if (value === undefined || value.startsWith('--')) {
      console.error(`preview: ${name} needs a value`)
      process.exit(2)
    }
    return value
  }

  const catalogArgument = valueOf('--catalog')
  const positional = argv.filter((argument, index) => (
    !argument.startsWith('--')
    // Skip a flag's value so `--catalog x.json` does not look like the output.
    && !(index > 0 && argv[index - 1] === '--catalog')
  ))
  return {
    catalog: catalogArgument === undefined ? join(PACKAGE, 'data/index.json') : resolve(catalogArgument),
    out: resolve(positional[0] ?? join(PACKAGE, 'preview.html')),
    dark: flag('--dark') !== -1,
  }
}

const options = parseArguments()
const catalogPath = options.catalog
const outPath = options.out

if (!existsSync(catalogPath)) {
  console.error(`preview: no catalog at ${catalogPath}`)
  process.exit(1)
}

const catalog = await readFile(catalogPath, 'utf8')
/** `--dark` renders the host's dark palette; the default is its light one. */
const dark = options.dark
const theme = themeSets()

const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<!-- Without this the headless probe lays the page out at 980px and scales it
     down, so every media query under 980 never fires and a 390 screenshot is
     a lie. The host's own document carries the same tag. -->
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-suite-store preview</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Funnel+Display:wght@400..700&family=Funnel+Sans:wght@400..600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root {
${theme.light}
  --dsh-font-family-text-default: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
/* The host's own dark palette, under the host's own selector. Two blocks, not
   one: merged, the dark values win and no light screenshot is possible. */
${theme.selector} {
${theme.dark}
}
html, body { height: 100%; margin: 0; }
body { background: var(--dsw-alias-bg-base, #fff); font-family: var(--dsw-font-family, var(--dsh-font-family-text-default)); }
#app { height: 100vh; display: flex; flex-direction: column; }
</style>
</head>
<body${dark ? ' data-ds-dark-theme=""' : ''}>
<div id="app"></div>
<script>
// The host supplies React as a shared module, so the bundle requires it. The
// preview maps those two ids onto React loaded as an ES module below, which
// is the smallest honest stand-in for the host's module registry.
const registry = {};
function require(id) {
  if (registry[id] !== undefined) return registry[id];
  throw new Error('preview: unexpected require(' + id + ')');
}
window.__require__ = require;
window.__ModuleLoader__ = {
  load(entry) {
    const exports = entry.factory(require);
    registry[entry.id] = exports;
    window.__previewExports = exports;
    return exports;
  },
};
// A less-than sign is escaped so a catalog value containing a closing script
// tag cannot terminate this block and inject markup into the generated page.
window.__CATALOG__ = ${JSON.stringify(catalog).replace(/</gu, '\\u003c')};
</script>
<script type="module">
import * as React from 'https://esm.sh/react@18.3.1';
import * as JsxRuntime from 'https://esm.sh/react@18.3.1/jsx-runtime';
import { createRoot } from 'https://esm.sh/react-dom@18.3.1/client';

window.__previewRegistry = registry;
registry['react'] = React;
registry['react/jsx-runtime'] = JsxRuntime;
registry['react-dom/client'] = { createRoot };
document.dispatchEvent(new Event('preview-react-ready'));
</script>
<script>
// Load the bundle only after React exists, because its factory runs
// synchronously on registration and requires React at that moment.
document.addEventListener('preview-react-ready', function load() {
  const script = document.createElement('script');
  script.src = 'client/client.js';
  script.onload = boot;
  document.head.appendChild(script);
});

function boot() {
  const plugin = window.__previewExports;
  const React = window.__previewRegistry['react'];
  const { createRoot } = window.__previewRegistry['react-dom/client'];
  if (!plugin) {
    // Said out loud rather than left as a blank page: the commonest cause is a
    // stale client bundle (or one that failed to build), and a reader who sees
    // an empty preview has no way to tell that from a broken UI.
    document.getElementById('app').textContent =
      'preview: client/client.js did not register its exports — run pnpm run build:client first.';
    return;
  }
  let panel = null;
  /**
   * Called the moment the plugin registers its main slot.
   *
   * The client DISPOSES and re-registers on a timer (retry/delayFor): it waits
   * for the host to declare the slot, and its first setTimeout fires after the
   * current synchronous pass. Rendering straight after apply() therefore
   * rendered null and the page was blank — the plugin was working and the
   * preview was reading it too early.
   */
  let onPanelRegistered = null;
  const ctx = {
    slots: {
      // entries is deliberately absent: the client then treats a successful
      // register as settled, which is the behaviour a host without a
      // slot-inspection API has. Adding it here would need real entry objects
      // to answer with, and a wrong answer stores a permanent "settled" flag.
      register(options, render) {
        if (options.name === 'main') {
          panel = render;
          if (onPanelRegistered !== null) {
            const notify = onPanelRegistered;
            onPanelRegistered = null;
            notify();
          }
        }
        return () => {};
      },
    },
    effect(setup) { return setup(); },
    get() { return undefined; },
  };
  // The page store reaches the host through fetch; the preview answers from
  // the catalog file so the real component tree renders without a server.
  //
  // The /api/install endpoint is answered too, because the install panel is a page state
  // no iteration on the grid can exercise: without it the panel that carries
  // the whole §7.5 contract is the one surface nobody ever looks at.
  const realFetch = window.fetch.bind(window)
  let installStartedAt = 0
  window.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/api/bundles')) {
      return new Response(window.__CATALOG__, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/api/capabilities')) {
      return new Response(JSON.stringify({ canRestart: false, hostKind: 'desktop', installable: true }), { status: 200 });
    }
    if (url.includes('/api/install')) {
      installStartedAt = Date.now();
      // The real route answers 200 with the whole record, because the caller
      // may be attaching to an operation that already started.
      return new Response(JSON.stringify({ opId: 'preview-op' }), { status: 200 });
    }
    if (url.includes('/api/progress')) {
      // A scripted operation: members land one per 700 ms and one of them
      // fails, so the panel is seen in the state that actually matters —
      // a run that is neither clean nor finished.
      //
      // The event names and payloads have to match the real stream exactly,
      // because the client subscribes to a fixed list of named events and
      // reads the record from the op field on every one of them. A friendlier
      // shape here would render nothing and look like the panel was broken.
      const members = ['context', 'cost', 'skills', 'git-graph', 'remote'];
      const startedAt = new Date(installStartedAt || Date.now()).toISOString();
      /**
       * One member row's state at frame N.
       *
       * Extracted from the nested ternary it used to be: two conditional
       * operators in one expression, and the failure branch had to repeat the
       * same predicate.
       *
       * @param index - the member's position.
       * @param frame - how many members have finished.
       * @returns the mocked state.
       */
      const memberState = (index, frame) => {
        if (index < frame) return index === 2 ? 'failed' : 'ok';
        if (index === frame) return 'running';
        return 'pending';
      };
      const frameOf = (n) => {
        const rows = members.map((key, i) => {
          const state = memberState(i, n);
          return {
            key,
            name: key,
            state,
            ...(state === 'failed'
              ? { failure: { key, phase: 'add', type: 'install-failed', reason: 'pnpm exited 1' } }
              : {}),
          };
        });
        return {
          op: {
            opId: 'preview-op',
            bundleId: 'daily-driver',
            bundleVersion: '1.0.0',
            hostKind: 'desktop',
            status: n >= members.length ? 'partial' : 'installing',
            startedAt,
            updatedAt: new Date().toISOString(),
            members: rows,
          },
        };
      };
      const body = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          const send = (event, data) =>
            controller.enqueue(encoder.encode('event: ' + event + '\\ndata: ' + JSON.stringify(data) + '\\n\\n'));
          send('capabilities', { type: 'capabilities', canRestart: false, hostKind: 'desktop' });
          send('snapshot', { type: 'snapshot', op: null });
          let n = 0;
          const tick = setInterval(() => {
            const finished = n >= members.length;
            const name = n === 0 ? 'op-start' : finished ? 'op-end' : 'member-done';
            send(name, { type: name, ...frameOf(n) });
            n += 1;
            if (finished) {
              clearInterval(tick);
              // Closing the stream is what lets the page settle: leaving it
              // open kept the client's reader alive forever, and the mock
              // fetch had no other way to end.
              controller.close();
            }
          }, 700);
          // A reader that goes away must not leave the interval running.
          this.cancel = () => clearInterval(tick);
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return realFetch(input, init);
  };
  try {
    plugin.apply(ctx, {});
  } catch (error) {
    document.getElementById('app').textContent = 'preview: apply() threw — ' + error.message;
    return;
  }
  const root = createRoot(document.getElementById('app'));
  /**
   * Draw whatever the plugin has registered so far.
   *
   * Called from the registration callback AND once after apply(), because the
   * order is not guaranteed: a plugin that registers synchronously has already
   * done so by the time apply() returns, while this client registers on a
   * timer. Calling it twice is harmless — createRoot().render() replaces the
   * tree — and a single call in either position would leave one case blank.
   */
  function draw() {
    if (panel === null) return;
    root.render(React.createElement(React.Fragment, null, panel({})));
  }
  onPanelRegistered = draw;
  draw();
  // The client retry chain starts at 0 ms and may need a frame; these catch a
  // registration that lands after the synchronous draw.
  setTimeout(draw, 50);
  setTimeout(draw, 400);
}
</script>
</body>
</html>
`

const outDir = dirname(outPath)
const clientDir = join(outDir, 'client')
await mkdir(clientDir, { recursive: true })
await writeFile(outPath, page, 'utf8')
await copyFile(join(PACKAGE, 'client/client.js'), join(clientDir, 'client.js'))
console.log(`preview: wrote ${outPath}`)
