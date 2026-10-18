# signal-design (vendored)

Prebuilt copy of [Medalink/signal-design](https://github.com/Medalink/signal-design)
for Watcher's WebView2 page. Watcher has no npm build, so the library is vendored
as files; nothing here is hand-edited.

- `signal.css` + `fonts/` — built with `pnpm build:css` (tokens, themes, base
  layer, every `sd-` component; no Tailwind utilities).
- `js/` — the library's ES modules, imported directly by the page.

Pinned to signal-design commit `2063c67` (main, includes PR
https://github.com/Medalink/signal-design/pull/1 — `sd-plot`, `sd-stat-box`
and sortable table headers, which Watcher uses).

To update: build that repo (`pnpm build:css`), then refresh `signal.css`,
`fonts/` and `js/` from the built source and update the pinned commit here.
