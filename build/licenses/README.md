# Packaged Electron / Chromium licence files

These are the upstream `LICENSE` and `LICENSES.chromium.html` files from the
Electron release that `package.json` pins (`electron` in `devDependencies`).
`package.json` → `build.mac.extraResources` copies them into the macOS app
bundle as `LICENSE.electron.txt` and `LICENSES.chromium.html`.

They live in the repo on purpose. CI installs with `npm ci --ignore-scripts`, so
`node_modules/electron/dist/` is never populated and any `extraResources` entry
pointing there is skipped silently by electron-builder. Committing the files
makes the ship path independent of install state.

When bumping Electron, refresh both files from that version's official dist
zip (same contents as `node_modules/electron/dist/` after `npm run setup`).
