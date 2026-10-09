# @zhengjunyao/dsh-qqmail

A QQ Mail (and any IMAP/SMTP mailbox) plugin for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) — **the agent's mailbox**. It registers `qqmail_*` agent tools that list, search, read, send, reply to, flag, move, delete and download mail over plain IMAP/SMTP, and ships two more entry points over the same core: a `qqmail` CLI and a `qqmail-mcp` stdio MCP server for other agents.

Authentication is a **provider authorization code**, not OAuth: enable IMAP/SMTP in the QQ Mail web console, generate a 16-character code, and paste it in. No OAuth application, no 2FA redirect, no browser round trip.

- **Read tools** (`qqmail_status`, `qqmail_config`, `qqmail_folders`, `qqmail_list`, `qqmail_search`, `qqmail_read`, `qqmail_attachment`) are always registered.
- **Write tools** (`qqmail_send`, `qqmail_reply`, `qqmail_mark`, `qqmail_move`, `qqmail_delete`) are **not registered at all** while `readOnly` is on (the default), so nothing can send or delete by accident.
- **Deletion defaults to moving into the Trash folder.** Permanent `\Deleted` + `EXPUNGE` requires an explicit `permanent: true`.
- **The authorization code never reaches the model**: tool results and the web panel only ever show a mask.

## Getting the QQ Mail authorization code

1. Open QQ Mail in a browser → **设置 / Settings** → **账号 / Account**.
2. Find **IMAP/SMTP服务** → enable it (a verification step is required).
3. Copy the generated **16-character authorization code**.
4. Configure the plugin with it:

```
qqmail_config  email: "someone@qq.com"  authCode: "<the 16-character code>"
```

Then verify with `qqmail_status probe: true` — it connects to both servers for real and reports which side failed, in plain language (a wrong password vs. a missing service toggle are different messages).

> The authorization code is *not* your QQ password. It can be revoked in the same screen without touching your account.

## Installation

```bash
# from a GitHub repo tagged with the `dsh-plugin` topic
dsh plugin --profile web add github:zhengjy01/dsh-qqmail

# or from npm
dsh plugin --profile web add @zhengjunyao/dsh-qqmail

# local development
dsh plugin --profile web add link:/path/to/dsh-qqmail
```

Restart `dsh web` afterwards; the plugin appears as the **QQ 邮箱** card in Settings.

## The three entry points

### 1. Agent tools (the main one)

Twelve `qqmail_*` tools, described in the system prompt so the model knows they exist:

| Tool | What it does |
| --- | --- |
| `qqmail_status` | Config + `probe: true` for a real IMAP/SMTP connection check |
| `qqmail_config` | Set address, authorization code, provider preset, switches |
| `qqmail_folders` | List folders with message/unseen counts |
| `qqmail_list` | Newest-first listing of a folder |
| `qqmail_search` | Search by sender / recipient / subject / body / date / unread / flagged / size |
| `qqmail_read` | Read one or many messages in full (batch `uids` is much faster) |
| `qqmail_attachment` | Download attachment N of a message to disk |
| `qqmail_send` | Send a message (files as attachments) |
| `qqmail_reply` | Reply with `Re:`, `In-Reply-To`, `References` and a quoted original |
| `qqmail_mark` | Read/unread, starred/unstarred |
| `qqmail_move` | Move between folders |
| `qqmail_delete` | Move to Trash (default) or delete permanently |

### 2. CLI

```bash
qqmail status --probe
qqmail folders
qqmail list --mailbox INBOX --limit 20 --unseen
qqmail search --from finance --since 2026-09-01
qqmail read 12345 12346
qqmail send --to a@b.com --subject "Hi" --text "Body" --attach ./report.pdf
qqmail reply 12345 --text "收到"
qqmail mark 12345 --seen --flag
qqmail move 12345 --to "Archive"
qqmail delete 12345
```

Every command accepts `--json` for the structured payload. The CLI reads the same `<DSH_HOME>/dsh-qqmail.json`, so configuring the mailbox once is enough — and `QQMAIL_AUTH_CODE` (or `--auth-code -` reading stdin) keeps the secret out of the process list.

### 3. MCP stdio server

For agents that cannot host a DSH plugin:

```jsonc
// Claude Code / Codex / any MCP client
{
  "mcpServers": {
    "qqmail": {
      "command": "npx",
      "args": ["-y", "@zhengjunyao/dsh-qqmail", "qqmail-mcp"]
    }
  }
}
```

`npx @zhengjunyao/dsh-qqmail qqmail-mcp` runs the server directly; `bin` also exposes it as `qqmail-mcp`. Tool schemas are generated from the same definitions the DSH tools use, so the two never drift. Only stderr carries diagnostics — stdout belongs to the JSON-RPC transport.

Write tools follow the configured `readOnly` switch; pass `--allow-write` to expose them regardless.

## Configuration

Stored in `<DSH_HOME>/dsh-qqmail.json` (mode `0600`; `DSH_HOME` defaults to `~/.dsh`).

| Key | Default | Meaning |
| --- | --- | --- |
| `preset` | inferred from the address | `qq` / `qq-exmail` / `163` / `126` / `gmail` / `outlook` / `custom` |
| `email` | — | Full address; also the IMAP/SMTP login |
| `authCode` | — | Provider authorization code (the secret) |
| `imapHost` / `imapPort` / `imapSecure` | preset | Override the IMAP endpoint |
| `smtpHost` / `smtpPort` / `smtpSecure` | preset | Override the SMTP endpoint |
| `smtpRequireTls` | `true` | Refuse to send over a non-upgraded plaintext session |
| `fromName` / `signature` | `''` | Display name and plain-text signature |
| `sentFolder` | auto-detect | Where the Sent copy is appended |
| `downloadDir` | `<DSH_HOME>/dsh-qqmail/attachments` | Default attachment directory |
| `readOnly` | `true` | `false` registers the write tools |
| `timeoutMs` | `30000` | Connect / command budget |
| `maxParseMb` / `maxSendMb` | `40` | Size caps in both directions |
| `previewInList` | `false` | Include a body preview in listings |
| `saveSent` | `true` | Append a copy of outgoing mail to Sent |

Provider presets and their credential instructions are in `src/core/presets.ts`. Enterprise QQ Mail (exmail) uses a custom domain, so its preset must be selected explicitly.

## Behaviour worth knowing

- **Chinese search terms are filtered locally.** RFC 3501 `SEARCH` has no charset negotiation QQ Mail honours in practice, so a Chinese keyword would come back as a silent zero-match. Those searches scan a recent window (about 400 messages) in-process and report `mode: "local"`.
- **An ASCII body search that matches nothing is re-checked locally.** Non-ASCII bodies are MIME-encoded, so an ASCII word inside a Chinese body is invisible to the server. Reporting "no matches" there would be a false negative.
- **`hasAttachments` in listings is structural.** ImapFlow's parsed `BODYSTRUCTURE` does not expose `content-disposition`, so the flag is derived from part types, name parameters and Content-IDs. The authoritative attachment list comes from `qqmail_read`.
- **Connections are pooled and serialized.** One IMAP connection per account, commands serialized (IMAP has a single selected mailbox per connection), closed after 60 s idle; the CLI closes it immediately.
- **Sent copies reuse the exact bytes that were sent**, so the archived message has the same `Message-ID` as the delivered one and threads correctly in other clients.

## Security notes

- The authorization code is written to `<DSH_HOME>/dsh-qqmail.json` with mode `0600`. It is never returned by a tool, a route or the panel, and never logged.
- Write tools are absent from the registry while `readOnly` is on — not merely refused at call time.
- TLS certificates are verified; the plugin does not offer an "ignore certificate errors" switch. `smtpRequireTls` only exists for servers that genuinely speak plaintext (a local relay).
- Deletion is a move to Trash unless `permanent: true` is passed explicitly.

## Development

```bash
pnpm install
pnpm run build          # tsc --noEmit declarations + tsdown + shebang/chmod postbuild
pnpm run typecheck
pnpm test               # 90 unit + 68 end-to-end + 37 CLI/MCP assertions
pnpm run verify         # portability gate (isolated DSH_HOME, real install)
```

The end-to-end suites drive the real code over real sockets against the in-process fake SMTP/IMAP servers in `tests/fakes.mjs`, so session pooling, envelope parsing, body-part previews, flag stores, folder moves, the Sent append and attachment download are all exercised without touching a real mailbox.

See `PORTABILITY-SOP.md` for the release gate this plugin is verified against.

## License

MIT


## Multi-account development build

Use qqmail_config with account:"__new__" or qqmail_accounts action:"add" to add a mailbox (email/authCode, optional id/label/preset). Omitting account updates the default mailbox. Existing tools accept an account id or email; unknown references fail with available choices. UIDs are scoped to account + mailbox. qqmail_accounts lists, selects the default and removes with confirm:true. CLI supports --account; MCP uses the same specs.

For custom business/education domains hosted by Tencent, explicitly set preset:"qq-exmail". Signatures, saveSent, previewInList and download directories are account settings; readOnly is plugin-wide. Multi-account default downloads use per-id subdirectories, while single-account paths remain compatible.

The multi-account UI and live dual-mailbox acceptance are pending. Use an isolated development profile before replacing an active desktop installation. See docs/multi-account-core.md.
