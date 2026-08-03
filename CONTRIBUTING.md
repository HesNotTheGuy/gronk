# Contributing

Thanks for looking. This is a small project, so the rules are short.

## Getting it running

```bash
npm run setup
npm run dev
```

You need Node 22.18 or newer, and the Grok CLI installed and signed in. `setup`
installs with lifecycle scripts disabled, scans what landed, then fetches only
the Electron binary. See [docs/supply-chain.md](docs/supply-chain.md) for why.

## Before you open a pull request

```bash
npm run verify
```

That runs the typecheck and the test suite. CI runs the same thing on Windows,
macOS and Linux, plus a malware scan of the lockfile. If `verify` passes locally
it will almost always pass in CI.

## What makes a change easy to accept

- **One thing per pull request.** A focused change gets reviewed in a day. A
  branch that fixes a bug, renames some files and adjusts formatting takes weeks
  and usually stalls.
- **Say what breaks if you are wrong.** "Fixes the crash when the store is
  missing" is more useful than "improve error handling".
- **Tests for logic, judgement for the rest.** Anything that parses, validates,
  or decides should have a test. UI layout does not.
- **Comments explain why.** The code already says what it does.

## How a pull request gets reviewed

Fork the repo, branch, push to your fork, open a pull request against `main`.
Nobody else has write access here, so that is the only route in, including for
trivial changes.

CI runs typecheck and the full test suite on Windows, macOS and Linux, plus a
scan of the lockfile. That is the objective part and it has to be green.

Two checks cannot run in CI, because they need a real display:

```bash
npm run test:visual     # renders 30 app states, compares against a baseline
npm run test:preview    # drives the dev-server preview under real Electron
```

A maintainer runs those before merging anything that touches `src/`. You do not
need to run them. Say which screens your change affects and they will be looked
at. If a screen legitimately changed, the baseline gets updated in the same
merge; that is expected, not a failure.

Changes that touch the main process, IPC, path handling, plugins, CSP, or
permissions get an extra careful pass. The public docs for that posture are
[SECURITY.md](SECURITY.md) and [docs/supply-chain.md](docs/supply-chain.md).
Internal review checklists stay off the public tree on purpose.

Expect questions rather than silence. A change that gets a lot of them is
usually one that needed them, not one that is unwelcome.

## Where things live

```
electron/main/     Main process: spawns the CLI, owns IPC, touches the disk
electron/preload/  The bridge. Every API the renderer can see
src/               React renderer. No Node access
shared/            Types and helpers both sides use
tests/             node:test, no framework
```

Two conventions worth knowing before you move code around:

**Pure logic lives in plain `.ts`, away from Electron and from `.tsx`.** The
test runner loads TypeScript directly and cannot strip types from JSX, and it
cannot import `electron` outside an Electron process. That is why files like
`plugins-map.ts` and `plugin-view.ts` exist next to the modules that use them.
Put logic there and it can be tested; bury it in a component or next to a
`spawn` call and it cannot.

**Every `ipcMain.handle` starts with `assertTrustedSender(e)` and validates its
arguments.** The handler count and the guard count are expected to match. If you
add a handler without one, that is the bug.

## Things that will get pushed back on

- New npm dependencies. The runtime list is four packages and the reason is in
  [docs/supply-chain.md](docs/supply-chain.md). Bring a good argument.
- Anything that renders model output, tool results, or marketplace text as
  markdown or HTML. It is all untrusted input and stays inert text.
- Weakening a permission prompt, a path check, or a sender check to make
  something more convenient.

None of these are absolute. They just need a reason in the pull request.

## Reporting bugs

Include your OS, your Node version, and the output of `grok version --json`. If
the app misbehaved, say what you expected instead. Security issues go through
[SECURITY.md](SECURITY.md), not the issue tracker.

## Licence

Contributions are accepted under the [Apache License 2.0](LICENSE), the same
licence as the project.
