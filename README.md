# USAGE Miner

A small Windows program that points the AI tools already on your computer at
[USAGE](https://usage-ten.vercel.app), so the compute you were going to use
anyway can be measured and verified.

It is published here because of what it does: it holds a credential, it edits
your AI tools' configuration, and it talks to a server on your behalf. Asking
anyone to trust that without letting them read it would be asking for something
we would not give ourselves.

**Windows 10/11, 64-bit.** Claude Code supported. Codex experimental.

---

## What it does

* **Pairs with a USAGE account** through your browser. You approve the device on
  a page where you are already signed in; the credential travels back over a
  poll channel. There is no key to copy and nothing to paste.
* **Routes supported AI tools through USAGE**, so their usage can be observed
  and turned into a signed Proof of Usage.
* **Protects its device credential.** Stored encrypted with Windows DPAPI,
  scoped to your Windows account. Never printed, never logged, never written
  into a tool's configuration file, never placed in a shortcut.
* **Never receives a provider API key.** Your OpenRouter or Anthropic key stays
  on USAGE's servers. This program holds one scoped credential of its own,
  which can route requests, read its own configuration, send a heartbeat and
  replace itself — and nothing else.
* **Does not inspect or store prompts, responses, tool arguments, or source
  code.** It configures routing and gets out of the way.

It is **not** a trusted usage reporter. It cannot submit token counts, cost,
generation ids or verification status. Whatever it claimed would not be
believed; USAGE measures what it observes at its own gateway.

## Two ways to route a tool

**Launched.** USAGE starts the tool and puts routing in that child process's
environment. It exists while the tool runs and is gone when it exits. Nothing is
written to disk. This is how **Claude Code** works, and the only way it works —
its settings file takes literal values and cannot name a credential held
elsewhere, so configuring it persistently would mean leaving a token on disk.

**Configured.** The tool's own config file is edited, and may only *name* a
credential rather than contain one. **Codex** can do this
(`env_key = "USAGE_MINER_TOKEN"`).

Either way, what was there before is backed up first, turning mining off puts it
back exactly, and a tool already pointing somewhere custom is reported rather
than overwritten.

## Install

Download the installer from
[Releases](https://github.com/Deniscoke/USAGE-Miner/releases), or from the
[USAGE download page](https://usage-ten.vercel.app/miners/install).

Per-user install. No administrator rights, no service, no scheduled task, and it
does not start with Windows. Uninstalling offers to restore every tool's
original settings first.

**Verify what you downloaded** before running it:

```
certutil -hashfile USAGE-Miner-<version>-Setup.exe SHA256
```

Compare against `SHA256SUMS.txt` in the same release.

## Build from source

Needs [Node.js](https://nodejs.org) 24 and Windows. Nothing else — the installer
is compiled with the C# compiler that ships inside Windows.

```bash
git clone https://github.com/Deniscoke/USAGE-Miner
cd USAGE-Miner
npm ci
npm run typecheck && npm test
npm run package
```

Artifacts land in `dist/artifacts/`.

**The standalone executable is byte-for-byte reproducible.** Build it from the
same commit on the same Node version and you get the same SHA-256 as the
published one. That is the check worth doing: it means the published binary
contains this source and nothing else.

The installer wrapper is not reproducible — the in-box Windows C# compiler has
no `/deterministic` switch and stamps a fresh module id into every build. Each
release's `release.json` marks this per file, so an apparent mismatch there is
the toolchain, not a tampered download.

### How it is built

The application is Node's [Single Executable
Application](https://nodejs.org/api/single-executable-applications.html): our
bundled script injected into a copy of the Node runtime. That is why it is ~87
MB and why you need no runtime installed. The code is bundled unminified on
purpose — extract the blob and it is readable, with real names.

## Security and privacy

**What USAGE records:** model, token counts, cost, latency, timing.
**What it never records:** prompts, responses, tool arguments, source code.

The local window is an HTTP server on `127.0.0.1` with an ephemeral port. Every
request must carry a random session nonce minted at startup, a request from a
foreign origin is refused, and the only URLs it will open come from a fixed
allowlist. Treat localhost as untrusted — other programs run there too.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Releases and signing

Release builds are produced by GitHub Actions on a GitHub-hosted Windows runner
from an exact commit — see [`.github/workflows/release.yml`](.github/workflows/release.yml).
A locally built executable is never published as a release artifact.

Builds up to and including `v0.3.0-beta.1` are **not code-signed**. Windows
SmartScreen warns about an unrecognised publisher, and that warning is correct;
verify the SHA-256 instead.

Signing through [SignPath Foundation](https://signpath.org/) is in progress. When
it lands, a signature will prove *publisher identity and file integrity*. It is
not a promise that Windows stops warning: SmartScreen also weighs a publisher's
reputation, and a new certificate starts without one.

## Licence

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) — the licence grants no rights to
the USAGE name, which matters here: being able to tell whose build is holding
your credential is a security property, not branding.

The USAGE platform itself — reward policy, pricing, provider secret storage,
receipt signing, settlement — is a separate private codebase. This repository
contains only the client and depends on the platform solely through its
documented public HTTP API.

USAGE Points are off-chain, non-transferable, and carry no monetary value. This
is not an investment, and nothing here is a cryptocurrency.
