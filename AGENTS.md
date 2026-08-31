# Working on Gronk

Gronk is an Electron desktop app wrapping the Grok Build CLI. The maintainer
directs the work and does not read code, so everything below exists to make a
change safe to merge without a human reading the diff line by line.

Read this before your first edit. These rules apply to every agent and tool that
edits this tree — Claude, Grok, Cursor, or anything else. Do not assume a file
outside the repo still holds the hard rules.

## The shape of a change

One PR per idea. Every PR:

1. **has tests that fail without it.** Then break the fix on purpose and watch
   the named test fail — a test that passes both ways is worse than none,
   because it will be trusted. This has caught vacuous tests here repeatedly.
2. **passes `npm run typecheck` and `npm test`** locally before it is pushed.
   CI runs the same on four OS/Node combinations.
3. **says what it does not know.** If a claim is unverified, write that in the
   PR body. "Probable cause, not proven" is a complete and acceptable answer.

Never push to `main`. Never push a `v*` tag — a tag builds and publishes a
public release, and that decision is the maintainer's alone.

## Hard rules

These are non-negotiable. "Cleanup" that breaks one of them is a bug.

- **Every `ipcMain.handle` starts with `assertTrustedSender`.** Checked per
  handler by `tests/ipc-handler-guard.test.ts` — not by totals, because 60
  handlers and 60 guards also describes a file where one handler has two and
  another has none.
- **Every renderer-supplied argument is narrowed by a validator from
  `ipc/validate.ts` before it is used.** A parameter's TypeScript type is erased
  at build time, so `(e, sessionId: string)` happily receives an object or an
  array and it reaches store reads and `path.join`. **Nothing enforces this** —
  a green `npm test` is not evidence your handler validates anything. It is on
  you and on review.
- **Never remove or skip `--permission-mode`**, including for `default`. Without
  it the CLI falls back to a config file that commonly auto-approves every tool
  while the UI still shows a gated mode.
- **Do not simplify containment checks** (`isPathInside`, `resolveInsideJail`,
  and friends). Trailing-separator compares and realpath before compare are load
  bearing; a shorter check reopens prefix escapes (`/data/priv` vs
  `/data/private`) and symlink escapes.
- **Settings describe the next session.** The running session is the one on
  screen. Do not read a picker's live value from stored settings while a session
  is up.
- **A restart is a new session with an empty transcript.** If a setting can only
  be read at spawn, it applies to *new* sessions and the UI must say so.
- **Credentials stay in the Grok CLI.** Gronk must not store, log, or forward
  tokens. Pattern redaction is not a substitute for never holding the secret.
- **Do not claim the `grok` child is OS-sandboxed to the project folder.** ACP
  fs helpers are jailed; approved tools (and YOLO) run as the user.
- **Model output, tool results, and marketplace text stay inert.** Do not render
  them as HTML or executable markdown.

Public posture: [SECURITY.md](SECURITY.md) and [docs/supply-chain.md](docs/supply-chain.md).
Internal review checklists stay off this tree on purpose.

## Hot modules

These files concentrate session lifecycle. A change that touches any of them must
be **one behaviour** plus a test that fails without it. No drive-by refactors,
renames, or "while I'm here" cleanups in the same PR:

- `electron/main/agent-manager.ts`
- `electron/main/acp/client.ts`
- `electron/main/store.ts`
- `src/hooks/useGronk.ts`

## Verify against the real CLI, not against belief

The app's behaviour depends on what `grok` actually does, and the CLI changes
often. Assumptions here have been wrong in ways nothing caught:

- `--reasoning-effort` is documented under both `grok --help` and
  `grok agent --help`, but only works between `agent` and `stdio`. Placed
  before `agent` it is accepted, exits 0, and is **silently ignored**.
- The CLI does not validate that flag's value at all. `--effort banana` exits 0.
- `session/set_model` demands the field `modelId`; `model` is rejected outright.

```bash
GRONK_LIVE_CLI=1 npm test
```

runs `tests/live-acp.test.ts` and `tests/live-cli.test.ts` against the installed
binary. **These cost nothing** — protocol calls are not prompts, and
`session/prompt` is refused inside the test helper so it cannot start costing
money. Run them first after any CLI update; they are the canary for what moved.

To learn something new about the CLI, probe it over ACP rather than reasoning
from documentation, then encode what you learn as a test.

## Comments: constraints, not stories

Write a comment when it changes what the next editor does — a verified CLI
behaviour, a jsdom asymmetry, a guard that looks like dead weight and is not.

Do not narrate. How a bug was found, what an earlier version did, which review
produced a fix, issue numbers: that belongs in the PR description. In source it
is noise the moment the change merges.

## Renderer testing

jsdom does not synthesize React's `onChange` from a dispatched input event, so
components here use `onInput` for text fields. React 19 also routes keyboard
events through an IE-era polyfill that needs `attachEvent`/`detachEvent` stubs
and a focused field. Copy the helpers in `tests/composer-slash.test.ts` rather
than rediscovering this.

`npm run test:visual` renders 38 app states and compares screenshots. It is not
run in CI (it needs a display). **Read the diff before re-recording** — see
issue #111 for a known false positive that drifts red on its own.

## Talking to the maintainer

Lead with the outcome and what it means, not the mechanism. They will not read
the code, so a summary that requires reading it has not communicated anything.
Say plainly when something failed, when a claim is unverified, and when you
have made a judgement call they might want to reverse.
