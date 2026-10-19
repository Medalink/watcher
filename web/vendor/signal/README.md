# Signal design kit (vendored)

Source: https://github.com/Medalink/signal-design, vendored from `main`
at commit `00b798d` (release 1.1.0; `signal.css` carries the
`/*! signal-design v1.1.0 */` banner).

- `signal.css`, `signal.js`, `fonts/` — copied from the kit's `dist/` build.
- `js/` — the kit's ES modules, copied from `src/js`.

Refresh: build the kit (`pnpm build:css && pnpm build:js`), mirror `dist/`
over this folder, then copy `src/js` over `js/`, and update this note.
