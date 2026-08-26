# Working on Gronk

Gronk is an Electron desktop app wrapping the Grok Build CLI. The maintainer
directs the work and does not read code, so everything below exists to make a
change safe to merge without a human reading the diff line by line.

Read this before your first edit. It is short on purpose; the deep security
rules live in `CLAUDE.md` at the workspace root (one level above this repo) and
apply to you too.

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

## Things that look like cleanup and are not

- **Removing a `--permission-mode` flag.** It is always emitted, including for
  `default`. Without it the CLI falls back to a config file that commonly
  auto-approves every tool while the UI still shows a gated mode.
- **Restarting the agent to apply a setting.** A restart is a new session with
  an empty transcript. If a setting can only be read at spawn, it applies to
  *new* sessions and the UI must say so.
- **Reading a picker's value from settings while a session is live.** Settings
  describe the *next* session. The running one is the one on screen.
- **Simplifying a containment check** (`isPathInside` and friends). Read
  `CLAUDE.md` before touching anything under `electron/main/ipc/`.

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
