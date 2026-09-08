# Security

## Reporting a vulnerability

**Please do not open a public issue.** This program holds a credential and edits
configuration files on people's machines; a public report is a working exploit
handed to everyone still running the affected build.

Use GitHub's private vulnerability reporting instead:

> **[Report a vulnerability](https://github.com/Deniscoke/USAGE-Miner/security/advisories/new)**
> — or: the repository's **Security** tab → *Report a vulnerability*

That channel is private between you and the maintainers, supports attachments
and back-and-forth, and becomes a published advisory with credit to you once a
fix ships. It needs no email address and nothing to be set up on your side.

If private reporting is unavailable to you for any reason, open a public issue
saying only *that* you have a security report and asking for a private channel —
no details, no reproduction steps.

### What to include

Whatever you have. Useful, roughly in order:

* the version (`USAGE-Miner.exe version`) and Windows build
* what an attacker gains, concretely
* how to reproduce it
* whether it needs local access, another program running as the same user, or
  only a web page the victim visits

### What to expect

This is a small project, run by people who also have other jobs. What is
promised is honest rather than impressive: an acknowledgement, a real assessment
rather than a form reply, and a fix or a stated reason there will not be one. If
a report is valid and a fix ships, the advisory credits you unless you ask
otherwise.

**Never send us a credential.** Not yours, not a victim's, not one you extracted
to prove the bug. Describe it instead. If a token has genuinely leaked, revoke
the device at `/miners` first and tell us afterwards.

## What is in scope

This repository — the Windows client. Things worth reporting:

* the device credential being readable by another program, another Windows
  account, or off the machine
* anything that reaches the local loopback server without the session nonce, or
  from a foreign origin
* a way to make the miner write, launch or open something the user did not ask
  for, including anything server-supplied that decides *what runs*
* a tool's configuration being damaged, or not restored on disable/uninstall
* prompts, responses, tool arguments or source code being read, stored or
  transmitted by this program
* the build or release process allowing a binary that is not from this source

The USAGE platform (the server, the gateway, the dashboard) is a separate
codebase. Report platform issues through the same private channel; they will be
routed.

## What is not a vulnerability

* **The binary is unsigned** (through `v0.3.0-beta.1`). Known, documented in the
  README, and being fixed through SignPath Foundation.
* **SmartScreen warns.** Correct behaviour for a binary without publisher
  reputation. Signing establishes identity; it does not silence the prompt.
* **A `.lnk` shortcut references the miner.** It carries an argument
  (`run claude-code`) and never a credential — verifiable with any shortcut
  inspector.
* **The credential is readable by a program already running as you.** True of
  every DPAPI `CurrentUser` secret, including the ones your browser holds. A way
  to read it as *another* user, or without code execution as you, is in scope.

## Supported versions

The latest release. This is a beta; older builds are not patched.

`0.2.x` wrote the device credential into `~/.claude/settings.json` in plaintext.
If you ran one, upgrade — `0.3.0` and later remove it, restore your previous
settings, and rotate the exposed credential automatically. You can also revoke
the device yourself at `/miners`.
