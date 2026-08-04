# Packaged Electron / Chromium licence files

These are the upstream `LICENSE` and `LICENSES.chromium.html` files from the
Electron release that `package.json` pins (`electron` in `devDependencies`).
`ELECTRON-VERSION` records that same pin next to the files so a drift is
visible without opening `package.json`. `tests/electron-licenses.test.ts`
fails when the two disagree.

`package.json` → `build.mac.extraResources` copies them into the macOS app
bundle as `LICENSE.electron.txt` and `LICENSES.chromium.html`.

They live in the repo on purpose. CI installs with `npm ci --ignore-scripts`, so
`node_modules/electron/dist/` is never populated and any `extraResources` entry
pointing there is skipped silently by electron-builder. Committing the files
makes the ship path independent of install state.

## Byte fidelity

`.gitattributes` marks `build/licenses/**` as `-text`. Without that, the global
`* text=auto eol=lf` rule classifies `LICENSES.chromium.html` as text (it has no
NUL bytes) and strips every CR on commit. The committed blob then fails an
auditor's hash check against Electron's published dist, while Linux/Windows
packages still ship the pristine file from electron-builder's own download.

The Chromium notices file for Electron 36.4.0 is 15,190,831 bytes and
sha256 `335b624d1b4f479532f7a2b974031f9a0c482dd599472489add4368ad9e9b8c8`.
That is the official dist content, CRs included. Do not re-save the HTML
through an editor that rewrites line endings.

## When bumping Electron

1. Bump `electron` in `package.json` / lockfile as usual.
2. After `npm run setup` (or from that version's official dist zip), copy:
   - `node_modules/electron/dist/LICENSE` → `build/licenses/LICENSE.electron.txt`
   - `node_modules/electron/dist/LICENSES.chromium.html` → `build/licenses/LICENSES.chromium.html`
3. Write the new version string alone into `build/licenses/ELECTRON-VERSION`.
4. Confirm the chromium file still has CR bytes and matches the dist size/hash
   before committing (`git check-attr text -- build/licenses/LICENSES.chromium.html`
   must report `text: unset`, not `auto`).
5. `npm test` — `electron-licenses` fails if `ELECTRON-VERSION` and the pin diverge.
