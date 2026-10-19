# Signal design kit (vendored)

Source: https://github.com/Medalink/signal-design — vendored from `main`
at commit `1191a71` (Merge pull request #9, sidebar-less shell; includes
#8, visible window-control icons).

- `signal.css`, `signal.js`, `fonts/` — copied from the kit's `dist/` build.
- `js/` — the kit's ES modules, copied from `src/js`.

Refresh: build the kit (`pnpm build:css && pnpm build:js`), mirror `dist/`
over this folder, then copy `src/js` over `js/`, and update this note.
