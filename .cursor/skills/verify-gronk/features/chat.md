# Chat

Chat is a conversation with Grok and no project folder. Nothing here reads or edits the user's files. History is previous chats on this machine.

## Sub-features

- `chat-browse` shows the Chat home (kicker `Chat`, heading `Talk with Grok`).
- `chat-new` starts a new conversation when signed in (`New chat`) or offers `Sign in to chat` when not.
- `chat-list` lists previous chats, or `No chats yet.` on a fresh profile.
- `chat-from-rail` reaches the same browse from the sidebar `Chat` item.

## How to get to it (user POV)

- On Home, press **Chat**.
- In the sidebar, press **Chat** (`nav[aria-label="Main"]`).
- Command palette actions that go to Chat.

## Driving it with control-gronk

Preconditions:

- Doctor is green.
- If `.auth-overlay` is up with no `Continue to app`, `chat-new` cannot start a session. You can still reach Chat browse only after the overlay is gone; otherwise report the unmet auth precondition.

- **From Home.** Run `control-gronk.mjs click --text Chat --within .home-actions`. Topbar kicker is `Chat`. Main kicker is `Chat`. Heading contains `Talk with Grok`. Copy mentions no project folder.
- **From the rail.** Return Home (`click --selector button.brand`), then `control-gronk.mjs click --text Chat --within nav[aria-label="Main"]`. Same Chat browse.
- **Empty list.** On a disposable userData dir, run `control-gronk.mjs wait --text "No chats yet."` or read `.browse-empty`. That is success for a new profile, not a missing feature.
- **New chat.** If signed in, `control-gronk.mjs click --text "New chat"`. The main pane leaves browse (`Talk with Grok` goes away) and a composer is present. If signed out, the button reads `Sign in to chat` and opens the auth overlay — do not call that a new session.
- **Proof.** `snapshot` and `screenshot` under `artifacts/verify-gronk/chat-browse.*`. Topbar and hero kickers both say `Chat`. No project path in the topbar subtitle.

## Gotchas

- Chat and Build both have a `Chat`/`Build` pair on Home. Rail vs hero are different entry points; name which one you used.
- Search (`Search every session by title or message text`) appears on Chat and Build, not on Home.
- Starting a real turn talks to the Grok CLI and can cost money. This map stops at browse + New chat. Do not send a prompt unless the task explicitly asked for a live turn.
- Session transcripts on the disposable userData dir are scratch. Cleanup deletes them. Proof PNGs stay in `artifacts/verify-gronk/`.
