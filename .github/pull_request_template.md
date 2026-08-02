<!--
Thanks for contributing. The checklist is short on purpose: everything on it is
something CI cannot check for you.
-->

## What this changes

<!-- One or two sentences. What was wrong, or what is now possible. -->

## What breaks if this is wrong

<!--
The most useful line in the whole template. "The preview pane loads nothing when
the dev server prints its URL with a query string" tells a reviewer where to
look. "Improved error handling" does not.
-->

## How you tested it

<!--
Say what you actually ran, not what should work. If you only ran the test suite,
say that. If you clicked through the app, say which screens.
-->

- [ ] `npm run verify` passes locally
- [ ] I ran the app and used the part I changed

## Checklist

- [ ] One thing per pull request. If this fixes a bug and also renames files,
      please split it.
- [ ] No new npm dependencies. If one is genuinely needed, say what it does and
      why it cannot be a few lines of local code.
- [ ] Comments explain **why**, not what.
- [ ] Anything that parses, validates or decides has a test.

## If you changed the UI

- [ ] I know `npm run test:visual` exists and that CI cannot run it

CI has no display, so screenshot comparison and the preview-window checks only
run on a maintainer's machine. Say which screens you touched and they will be
checked before merge. This is not something you need to run yourself.

## If you touched anything security related

Say so plainly here, even if you are confident it is fine. This includes the IPC
boundary, file path handling, how the CLI is spawned, what the store persists,
the content security policy, and how model output is rendered.

Flagging it is not an admission of anything. It routes the change to a closer
read, which is the point.
