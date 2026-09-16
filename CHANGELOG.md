# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-13

Initial release.

### Added

- **Agent tools** (`qqmail_*`): `status`, `config`, `folders`, `list`, `search`,
  `read`, `attachment` are always registered; `send`, `reply`, `mark`, `move`,
  `delete` register only when `readOnly` is off.
- **CLI** (`qqmail`): every tool as a command, with `--json` for structured
  output, and `QQMAIL_AUTH_CODE` / `--auth-code -` so the authorization code
  never lands in the process list.
- **MCP stdio server** (`qqmail-mcp`): the same tool definitions exposed over
  JSON-RPC for other agents, with stdout reserved strictly for the transport.
- **Web settings panel** (「QQ 邮箱」): provider preset, address, authorization
  code, behaviour switches, real connect check, inbox quick-look, compose box.
  The panel drives the same tool specs the agent calls, so the two surfaces
  cannot drift.
- **Provider presets**: QQ Mail, Tencent Exmail, 163, 126, Gmail, Outlook, plus
  a fully custom IMAP/SMTP endpoint.
- **IMAP layer**: pooled, serialized session per account with idle close;
  special-folder resolution via `SPECIAL-USE` with a name-matching fallback;
  header-only fetches with `BODYSTRUCTURE`; single-part body previews;
  flag stores, moves, trash-vs-permanent deletion, and `APPEND` for the Sent
  copy.
- **SMTP layer**: one MailComposer build reused for both delivery and the Sent
  append (so both copies share a `Message-ID`), STARTTLS enforcement on
  non-secure ports, and explicit size caps.
- **Search semantics**: ASCII terms go to the server; non-ASCII terms are
  filtered over a recent window locally and reported as `mode: "local"`. A
  zero-match *content* search is re-checked locally, because MIME-encoded bodies
  hide ASCII terms from the server.
- **Tests**: 90 unit assertions, 68 end-to-end assertions over real sockets
  against in-process fake SMTP/IMAP servers, and 37 CLI/MCP assertions.
- **Portability gate**: `pnpm run verify` installs the packed tarball into an
  isolated `DSH_HOME`, boots an instance, checks the health route and the
  client bundle, and watches for late startup failures.

[0.1.0]: https://github.com/zhengjy01/dsh-qqmail/releases/tag/v0.1.0
