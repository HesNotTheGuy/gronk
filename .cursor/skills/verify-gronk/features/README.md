# Gronk verification map

This directory is the maintained source for verifying the user-facing behavior of Gronk. Read the index before driving the app, then use the matching feature file as the recipe.

Home, Chat, Build, Focus, and permission prompts are the top surfaces. Settings, plugins, preview, and search exist; they are not in this first map.

## Baseline preconditions

- Launch only through `control-gronk.mjs launch`. That uses `npm run dev` with a disposable `--user-data-dir` under `$TMPDIR/gronk-verify/` and CDP on port 9333.
- Run `control-gronk.mjs doctor` and require: our pid, our CDP port, disposable userData (not the default `gronk` app-data directory), and a renderer document that contains `.app`.
- Never drive a Gronk instance that this verification run did not start, unless `--cdp` is an intentional attach.
- Node `>=22.18`. `npm ci --ignore-scripts` plus Electron's own installer (`npm run setup` or `node node_modules/electron/install.js`) must already have run.
- Credentials stay in the Grok CLI. A fresh userData dir is usually **not signed in**. The auth overlay (`.auth-overlay`) then covers Home and cannot be dismissed. That is product behavior, not a driver bug.
- Complementary: `npm test`, `npm run typecheck`. `npm run test:visual` and `npm run test:preview` need a display and are not this skill. Do not re-record visual baselines blindly (issue #111).

## Driving conventions

- Start every recipe from the launched baseline unless its preconditions say otherwise.
- Prefer button text, `aria-label`, `aria-current`, `aria-pressed`, and the selectors in SKILL.md. `--within` disambiguates duplicate labels (`Chat` exists on Home and in the rail).
- Treat every command as literal.
- `eval` only reads state after a user action. Do not call `window.gronk.*` as the proof.
- Restore nothing in the user's real `gronk` data directory. Cleanup deletes only `$TMPDIR/gronk-verify/`. Keep `artifacts/verify-gronk/`.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes an ARIA/DOM snapshot and a screenshot with the Gronk brand or Home/Chat/Build kicker visible.
- If the auth overlay is up and there is no `Continue to app` button, Home is mounted underneath but not interactable. Report that as an unmet precondition. A DOM read that `.home-kicker` is `Home` is supporting evidence, not a completed click-through.
- Record the feature ID and entry point in every artifact filename.
- Do not report a skipped entry point as verified through a different path.
- Do not treat a shots-harness PNG as proof of this skill.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with control-gronk` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Home](./home.md) — landing pad: Chat, Build, account/CLI/model meta, activity heatmap. No folder or session catalog.
- [Chat](./chat.md) — conversations with no project folder.
- [Build](./build.md) — Grok pointed at a folder; folders and sessions live here.
- [Focus](./focus.md) — hide the sidebar and idle session tray.
- [Permission prompts](./permission-prompts.md) — Deny-default tool approval and YOLO confirm.
