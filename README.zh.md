# @zhengjunyao/dsh-qqmail

[DeepSeek Harness](https://github.com/deepseek-ai/dsh) 的 QQ 邮箱（以及任意 IMAP/SMTP 邮箱）插件——**让 agent 拥有自己的邮箱**。它注册 `qqmail_*` 系列 agent 工具，通过标准 IMAP/SMTP 完成列邮件、搜索、读取、发信、回复、标记、移动、删除与附件下载；同一套内核还带两个旁路入口：`qqmail` 命令行与 `qqmail-mcp`（stdio MCP 服务器），供其他 agent 接入。

认证走**邮箱授权码**而非 OAuth：在 QQ 邮箱网页版开启 IMAP/SMTP 服务、生成 16 位授权码填入即可。不需要申请 OAuth 应用、不需要两步验证跳转、不需要浏览器回调。

- **读取类工具**（`qqmail_status`、`qqmail_config`、`qqmail_folders`、`qqmail_list`、`qqmail_search`、`qqmail_read`、`qqmail_attachment`）始终注册。
- **写入类工具**（`qqmail_send`、`qqmail_reply`、`qqmail_mark`、`qqmail_move`、`qqmail_delete`）在 `readOnly` 打开时（默认）**根本不注册**，从源头上杜绝误发、误删。
- **删除默认是移动到「已删除」文件夹**（可恢复）；彻底删除必须显式传 `permanent: true`。
- **授权码不会进入模型上下文**：工具返回与设置面板都只显示掩码。

## 获取 QQ 邮箱授权码

1. 浏览器打开 QQ 邮箱 → **设置** → **账号**。
2. 找到 **IMAP/SMTP 服务** → 开启（需要一次验证）。
3. 复制生成的 **16 位授权码**。
4. 配置插件：

```
qqmail_config  email: "someone@qq.com"  authCode: "<16 位授权码>"
```

然后用 `qqmail_status probe: true` 自检——它会真实连接 IMAP 与 SMTP，并分别用可读的中文说明哪一侧失败（授权码错误与「服务没开启」是两类不同的提示）。

> 授权码**不是** QQ 密码；它可以在同一页面随时撤销，不影响账号本身。

## 安装

```bash
# 从打了 `dsh-plugin` topic 的 GitHub 仓库
dsh plugin --profile web add github:zhengjy01/dsh-qqmail

# 或从 npm
dsh plugin --profile web add @zhengjunyao/dsh-qqmail

# 本地开发
dsh plugin --profile web add link:/path/to/dsh-qqmail
```

之后重启 `dsh web`，设置页会出现「QQ 邮箱」卡片。

## 三个入口

### 1. agent 工具（主入口）

十二个 `qqmail_*` 工具，并在系统提示中公告，模型知道它们存在：

| 工具 | 作用 |
| --- | --- |
| `qqmail_status` | 配置状态；`probe: true` 时真实连接 IMAP/SMTP 自检 |
| `qqmail_config` | 配置邮箱地址、授权码、服务商预设与各项开关 |
| `qqmail_folders` | 列出文件夹及邮件数/未读数 |
| `qqmail_list` | 按最新在前列出某个文件夹的邮件 |
| `qqmail_search` | 按发件人/收件人/主题/正文/日期/未读/星标/体积搜索 |
| `qqmail_read` | 读单封或多封邮件全文（`uids` 批量读显著更快） |
| `qqmail_attachment` | 把某封邮件的第 N 个附件下载到本地 |
| `qqmail_send` | 发信（支持本机文件作附件） |
| `qqmail_reply` | 回复：自动带 `Re:`、`In-Reply-To`、`References` 并引用原文 |
| `qqmail_mark` | 已读/未读、星标/去星标 |
| `qqmail_move` | 在文件夹间移动 |
| `qqmail_delete` | 移到「已删除」（默认）或彻底删除 |

### 2. 命令行

```bash
qqmail status --probe
qqmail folders
qqmail list --mailbox INBOX --limit 20 --unseen
qqmail search --from finance --since 2026-09-01
qqmail read 12345 12346
qqmail send --to a@b.com --subject "Hi" --text "正文" --attach ./report.pdf
qqmail reply 12345 --text "收到"
qqmail mark 12345 --seen --flag
qqmail move 12345 --to "Archive"
qqmail delete 12345
```

所有命令都支持 `--json` 输出结构化结果。CLI 读同一个 `<DSH_HOME>/dsh-qqmail.json`，因此配置一次即可通用；`QQMAIL_AUTH_CODE` 环境变量（或 `--auth-code -` 从 stdin 读）可避免授权码出现在进程列表里。

### 3. MCP stdio 服务器

给无法承载 DSH 插件的 agent 使用：

```jsonc
// Claude Code / Codex / 任意 MCP 客户端
{
  "mcpServers": {
    "qqmail": {
      "command": "npx",
      "args": ["-y", "@zhengjunyao/dsh-qqmail", "qqmail-mcp"]
    }
  }
}
```

`bin` 也直接暴露 `qqmail-mcp`。工具 schema 由 DSH 工具所用的同一份定义生成，两边不会漂移。诊断信息只走 stderr——stdout 属于 JSON-RPC 传输通道。

写入类工具遵循配置里的 `readOnly`；加 `--allow-write` 可强制开放。

## 配置项

存放于 `<DSH_HOME>/dsh-qqmail.json`（权限 `0600`；`DSH_HOME` 默认 `~/.dsh`）。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `preset` | 按邮箱域名自动识别 | `qq` / `qq-exmail` / `163` / `126` / `gmail` / `outlook` / `custom` |
| `email` | — | 完整邮箱地址，同时作为 IMAP/SMTP 登录名 |
| `authCode` | — | 服务商授权码（密钥本体） |
| `imapHost` / `imapPort` / `imapSecure` | 预设 | 覆盖 IMAP 端点 |
| `smtpHost` / `smtpPort` / `smtpSecure` | 预设 | 覆盖 SMTP 端点 |
| `smtpRequireTls` | `true` | 非 SSL 端口上拒绝在未升级的明文会话中发信 |
| `fromName` / `signature` | `''` | 发件人显示名与纯文本签名 |
| `sentFolder` | 自动探测 | 已发送副本写入的文件夹 |
| `downloadDir` | `<DSH_HOME>/dsh-qqmail/attachments` | 附件默认目录 |
| `readOnly` | `true` | 设为 `false` 才注册写入类工具 |
| `timeoutMs` | `30000` | 连接/命令超时 |
| `maxParseMb` / `maxSendMb` | `40` | 收发两侧的体积上限 |
| `previewInList` | `false` | 列表是否附带正文预览 |
| `saveSent` | `true` | 发送后是否存副本到「已发送」 |

服务商预设与各自的凭据获取说明见 `src/core/presets.ts`。腾讯企业邮箱（exmail）通常使用自定义域名，需显式选择该预设。

## 值得了解的行为

- **中文关键词走本地过滤**：RFC 3501 的 `SEARCH` 在 QQ 邮箱上对非 ASCII 没有可依赖的 charset 协商，中文关键词会变成静默的零命中。因此这类搜索在本地扫描最近窗口（约 400 封），并在结果中标注 `mode: "local"`。
- **英文正文搜索零命中时会本地复查**：非 ASCII 正文会被 MIME 编码，服务器看不到其中的英文词；直接回「没有匹配」会是假阴性。
- **列表里的 `hasAttachments` 是结构推断**：ImapFlow 解析出的 `BODYSTRUCTURE` 不暴露 `content-disposition`，因此该标记由 part 类型、`name` 参数与 Content-ID 推断。准确的附件清单来自 `qqmail_read`。
- **连接池化并串行化**：每个账号一条 IMAP 连接，命令串行（IMAP 单连接只能选中一个邮箱），空闲 60 秒后关闭；CLI 用完即关。
- **已发送副本复用完全相同的字节**：归档邮件与投递出去的那封 `Message-ID` 一致，在其他客户端里能正确串成会话。

## 安全说明

- 授权码写入 `<DSH_HOME>/dsh-qqmail.json` 并设为 `0600`；任何工具、路由或面板都不会回显它，也不写日志。
- `readOnly` 打开时写入类工具**不在注册表中**，而不是调用时才被拒绝。
- TLS 证书严格校验，插件不提供「忽略证书错误」开关；`smtpRequireTls` 只用于确实只支持明文的服务器（例如本机中继）。
- 除非显式传 `permanent: true`，删除都是移动到「已删除」。

## 开发

```bash
pnpm install
pnpm run build          # 声明文件 + tsdown 打包 + shebang/权限后处理
pnpm run typecheck
pnpm test               # 90 项单测 + 68 项端到端 + 37 项 CLI/MCP
pnpm run verify         # 可移植性门禁（隔离 DSH_HOME + 真实安装）
```

端到端套件通过 `tests/fakes.mjs` 里的进程内假 SMTP/IMAP 服务器、在真实 socket 上驱动产品代码，因此连接池、envelope 解析、正文预览、标记、移动、已发送写入与附件下载全部被覆盖，且完全不碰真实邮箱。

发布前遵循的门禁见 `PORTABILITY-SOP.md`。

## 许可

MIT


## 多账号开发版

可通过 qqmail_config 的 account:"__new__" 或 qqmail_accounts action:"add" 新增账号；email/authCode 配合可选 id、label、preset。省略 account 修改默认账号，不会自动新增。已有工具全部接受账号 id 或邮箱引用；未知引用报错，uid 只在账号+文件夹内唯一。qqmail_accounts 可列出、设默认、确认删除。CLI 支持 --account；MCP 使用同一套规格。

BUPT 等腾讯企业邮箱域名请显式选择 preset:"qq-exmail"，不自动推测企业域名。签名、saveSent、previewInList、附件目录均为账号级，readOnly 为插件级。多账号默认附件按 id 分子目录；单账号保留旧路径。

当前多账号 UI 和真实双邮箱验收尚未完成；先在隔离开发 profile 使用，暂不替换正在使用的 desktop。实现与验收说明见 docs/multi-account-core.md。
