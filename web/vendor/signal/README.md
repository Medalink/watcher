# signal-design (vendored)

Prebuilt copy of [Medalink/signal-design](https://github.com/Medalink/signal-design)
for Watcher's WebView2 page. Watcher has no npm build, so the library is vendored
as files; nothing here is hand-edited.

- `signal.css` + `fonts/` — built with `pnpm build:css` (tokens, themes, base
  layer, every `sd-` component; no Tailwind utilities).
- `js/` — the library's ES modules, imported directly by the page.

Pinned to signal-design commit `10d47c9` (main, includes PRs
https://github.com/Medalink/signal-design/pull/2 — shell grid-areas scoped to
`.sd-shell` so `sd-rail`/`sd-titlebar` place normally outside a shell — and
https://github.com/Medalink/signal-design/pull/4 — the dist banner).

To update: build that repo (`pnpm build:css`), then refresh `signal.css`,
`fonts/` and `js/` from the built source and update the pinned commit here.
