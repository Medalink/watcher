# Signal design kit (vendored)

Source: https://github.com/Medalink/signal-design, vendored from commit
`b03a907` (package version 1.4.0 plus the unreleased showcase-critique fixes
on `main`; `signal-core.css` carries the `/*! signal-design v1.4.0 */` banner).

- `signal-core.css`, `font-source-code-pro.css` and `fonts/` come from the
  kit's `dist/` build. Watcher sets text in the system face and numbers in
  Source Code Pro, so it links the core stylesheet and the one font file
  instead of `signal.css`, which also declares Leon Sans and Literata.
  `fonts/` holds only the files `font-source-code-pro.css` names.
- `js/` is the kit's `src/js`, without `charts/` and `ascii/`, which need npm
  packages Watcher does not use. `js/icons.js` is the icon set.

Refresh: in a kit checkout, run `node scripts/build-css.mjs && node
scripts/build-js.mjs`. Copy `dist/signal-core.css`, `dist/font-source-code-pro.css`
and the font files that stylesheet names into this folder, copy `src/js` over
`js/` (leaving out `charts/` and `ascii/`), then update the commit and version
above.
