# Focus

Focus hides the sidebar and the idle session tray so the conversation fills the frame. It is a chrome toggle, not a different session.

## Sub-features

- `focus-on` enters Focus from the topbar button. The button reads `Exit focus` and `aria-pressed` is true. `.app` has `focus-mode`. The sidebar is not displayed.
- `focus-off` leaves Focus from `Exit focus` or a second `[`. The sidebar returns.
- `focus-key` toggles with `[` when focus is not in an input, textarea, select, or contenteditable.

## How to get to it (user POV)

- Press **Focus** in the topbar.
- Press `[` when not typing in a field.

## Driving it with control-gronk

Preconditions:

- Doctor is green.
- Auth overlay is gone. Focus is usable on Home as well as in a conversation; the sidebar hide is the observable.
- Focus is not already on (button text is `Focus`, `aria-pressed` is false).

- **Button on.** Run `control-gronk.mjs click --text Focus`. Button text becomes `Exit focus`. `aria-pressed` is true. Run `control-gronk.mjs eval --js "document.querySelector('.app')?.classList.contains('focus-mode')"`. Result is `true`. The sidebar node may still exist; it is `display: none`.
- **Button off.** Run `control-gronk.mjs click --text "Exit focus"`. Button text is `Focus`. `focus-mode` is absent.
- **Key.** From Focus off, `control-gronk.mjs press --key "["`. Same on-state as the button. Press `[` again to leave. If an input is focused, `[` types; blur first.
- **Proof.** Screenshot `artifacts/verify-gronk/focus-on.png` while `Exit focus` is visible and the rail is gone, plus `focus-off.png` after leave. Pair with the `eval` of `.app.focus-mode`.

## Gotchas

- `[` is ignored when the event target is `input, textarea, select, [contenteditable="true"]`. The composer is the usual trap.
- The idle session tray is hidden in Focus only when it is not `.open`. An expanded tray can still show. Prefer the sidebar hide as the pass/fail signal.
- Focus does not change `surface`. Home stays Home. Do not treat Focus as navigation.
- Do not use `eval` to `classList.add('focus-mode')` as the proof.
