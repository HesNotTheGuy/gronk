# Security policy

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's
[private vulnerability reporting](https://github.com/HesNotTheGuy/gronk/security/advisories/new).
That opens a discussion only you and the maintainers can see.

Include what you can: what the issue is, how to reproduce it, and what an
attacker could do with it. A rough report is better than no report.

Expect a first response within a week. If a fix is needed, it ships before the
report is made public.

## Scope

In scope:

- Gronk's own code: the Electron main process, IPC surface, preload bridge, and
  renderer.
- Anything that lets a malicious project, plugin, or agent response reach beyond
  what the user approved. Sandbox escapes, IPC that skips its sender check, path
  traversal out of the allowed roots, or a permission prompt that can be
  bypassed are all worth reporting.
- Credential handling. Gronk should never store, log, or forward tokens.

Out of scope:

- The Grok CLI itself. It is a separate program, not redistributed here. Report
  those to xAI.
- Tools running with your permissions after you approve them. That is the
  feature working as designed. A prompt that can be **skipped** is a bug; a
  prompt you clicked through is not.
- Findings that require an attacker to already have local access to your user
  account.

## What Gronk assumes

- Everything from a plugin marketplace, a tool result, or a model response is
  untrusted input, rendered as inert text.
- Every IPC handler validates its sender and its arguments.
- Credentials live in the Grok CLI, never in Gronk's own storage.

Notes on npm supply-chain hygiene, and why installs disable lifecycle scripts,
are in [docs/supply-chain.md](docs/supply-chain.md).
