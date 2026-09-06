# Permission prompts

When the agent wants to edit a file or run a command, Gronk asks first. Deny is the default button. A separate confirm stands in front of Bypass all (YOLO). Title text on a permission is agent-controlled.

## Sub-features

- `perm-dialog` — modal `role="dialog"` with `.modal-permission` and `data-kicker="PERMISSION"`.
- `perm-deny` — **Deny** is primary (`btn-primary`, autofocus). It rejects once.
- `perm-allow-once` / `perm-allow-session` / `perm-allow-always` — the other three actions.
- `perm-raw` — **Show raw payload** / **Hide raw payload** when a structured diff is shown.
- `yolo-confirm` — `Enable bypass permissions?` with **Keep gated** (safe) and **I understand, enable it**.

## How to get to it (user POV)

- In a live Build (or Chat) turn, wait until the agent requests a tool. The modal appears on top of the transcript.
- To see YOLO confirm: turn on Bypass / always-approve from Settings or the permission mode bar. The confirm is required before the mode flips.
- Static gallery only: `npm run test:visual` includes permission scenarios. That is not this skill and must not re-record baselines blindly.

## Driving it with control-gronk

Preconditions:

- Doctor is green.
- For `perm-dialog`: a real agent request is on screen. This skill does not inject a permission event. `eval` of a fake `permission-request` is not a user path.
- For `yolo-confirm`: you opened the control that enables bypass, and the confirm is visible.

- **Recognize the dialog.** `control-gronk.mjs wait --text "Deny"`. Document contains `.modal-permission`. Headline is `Write a file on disk`, `Run <kind>`, or `Authorize tool` — not the agent title alone.
- **Deny.** `control-gronk.mjs click --text Deny`. The dialog closes. The tool does not proceed. Prefer this in verification; it is the safe default.
- **Do not Always allow** on a throwaway proof unless the task requires that path. Always allow can persist in the CLI.
- **YOLO confirm.** When the heading `Enable bypass permissions?` is shown, `click --text "Keep gated"` leaves the mode unchanged. Treat **I understand, enable it** as a dangerous path; do not take it on a shared machine.
- **Proof.** Screenshot and snapshot while the dialog is open (`artifacts/verify-gronk/permission-open.png`) and after Deny (`permission-denied.png`). The open shot must show **Deny** as a primary button. Note the tool kind in the filename if you can read it.

## Gotchas

- You cannot reach a real permission modal without a live grok turn. If the CLI is missing or unsigned-in, report `perm-dialog` as blocked. Do not open `__shots.html?state=…` and call it this feature.
- The visual harness emits a fake permission event into the shots app. Useful for pixels; not a substitute for Deny on a live request.
- Agent-controlled titles can be long shell lines. Assert the kicker `PERMISSION` and the Deny button, not the title string.
- YOLO is `--permission-mode bypassPermissions`. Never tell the product to skip `--permission-mode`. Keep gated is the verification default.
- `npm run test:visual:update` is not cleanup and not proof. Issue #111 drifts on its own.
