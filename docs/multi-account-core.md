# 多账号核心开发与评审

关联上游 Issue #1。已实现核心迁移、13 个工具（含 qqmail_accounts）、账号参数、HTTP 路由和 CLI/MCP 入口。隔离安装及模拟双账号验收通过，可在开发 profile 绑定多个账号。多账号设置页和真实双邮箱验收尚未完成，完整改造状态为 **NOT READY**。

## 已固定的规则

- 磁盘格式为 `{version:2, defaultAccount, readOnly, accounts:[]}`；签名、saveSent、previewInList、服务器及目录均在账号内。只有 readOnly 是插件级行为设置。原稿 UI 把前两项放全局的表述与字段表冲突，此阶段以字段表为准。
- 省略引用时按默认 id 选择，默认失效则回落首个账号；listAccounts() 提供回落提示。显式未知引用或空字符串报错，并列出可用 id/email。
- id 精确匹配优先；email 大小写不敏感。自动 id 碰撞追加后缀；显式非法/重复 id 拒绝。账号修改邮箱时 id 保持稳定；重复非空邮箱拒绝，最多 10 个账号。
- view() 保留旧默认视图形状；view(ref) 选择单个账号；listAccounts() 返回带身份的多账号视图。均不返回 authCode 原字段，继续保留旧掩码提示。
- reset 无引用清空账号及插件设置；reset 带引用保留该账号 id 并重置字段；remove 需要明确 account 和 confirm: true。

## 写入顺序与恢复

1. 按配置绝对路径进入进程内共享队列，再读取磁盘，避免不同 Store 实例丢失更新。
2. 解析和校验；损坏 JSON、未知版本、非法账号集合拒绝普通 patch 覆盖。
3. 若源文件为 v1，写同目录 0600 备份临时文件并 fsync；以硬链接发布完整 `.v1.bak`，已有备份不覆盖；同步父目录。必须先完成备份，否则配置替换后可能没有可恢复的旧凭据。
4. 写同目录 0600 配置临时文件并 fsync，rename 替换原配置。替换失败保留原文件与内存缓存。
5. 发布新缓存、使其他实例缓存失效，按变更账号退休 session，最后同步配置目录。若最后的目录同步失败，明确报告“配置已保存”，不能把它当作未提交的失败重试。

恢复旧版本前先备份当前 v2 文件，再停止所有使用该文件的实例，并将 `.v1.bak` 复制到配置路径，保持 0600，然后启动旧版本。v1 备份只包含迁移时的旧账号，恢复它会丢掉迁移后的新增配置；先保留 v2 副本再做回滚。

队列只覆盖同一进程；独立 CLI/MCP 进程的并发写不受此锁保护，此阶段不要同时写同一配置。持久化路径在 macOS 测试，其他平台尚未验证目录 fsync 与硬链接支持；不将其作为跨平台或实际断电验证的证据。

## 连接失效

配置成功写入后失效受影响邮箱的 IMAP session 和 Sent/Trash/Drafts/Junk 缓存。端口、TLS 和 timeout 均覆盖；TLS 和 timeout 也加入连接 key。其他账号不被关闭。

退休先拒绝新任务，再排空已提交队列并关闭；旧账号快照通过代际校验，不能在异步发信恢复后重建旧 session 或写回旧文件夹缓存。发信已成功但配置随后改变时，存副本失败记录在 saveError 中，避免把邮件已发送报告成整体失败。

## 可执行验证

在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm verify
```

新增 `tests/multi-account.mjs` 为纯离线测试：迁移读取零改动、原字节备份、0600、备份不覆盖、备份/rename/fsync/目录同步失败、跨实例并发、账号作用域、默认回落、未知引用、上限、各连接字段单独变更、会话退休及旧快照失效。原有 e2e/CLI-MCP 测试使用本机假 IMAP/SMTP 服务，不连接真实邮箱。

本机 typecheck/build、冻结锁文件安装及全部 248 项测试通过。此前 verify 的 npm 12 输出解析、无鉴权健康检查与相对/分批客户端 URL 识别问题已修复；peerDependencies 与安装版 0.1.1 的 DSH 0.2.0-rc.2 兼容声明同步。当前 pnpm verify 通过干净 tarball 安装、宿主健康路由、客户端交付和 15 秒稳定性检查。另在运行中的隔离 profile 通过 HTTP/CLI 双账号模拟验收，包括新增、同 UID 隔离、probe、定向 SMTP 签名及默认切换。
真实 v1 配置仅复制到 0600 临时文件做离线差分：默认 view、Account 旧字段及 12 个工具的空参数离线响应与旧版字节一致，迁移备份匹配原字节，真实配置内容与 mtime 不变。这不代表真实收发邮件的所有响应都已逐字节验证。

## 后续评审门禁

工具、routes 和 CLI/MCP 已接入账号选择；剩余为多账号 UI 和真实邮箱验收。多账号默认附件目录为 `<dataDir>/attachments/<accountId>/`；单账号无显式 downloadDir 时保持旧路径；多账号时按 id 分目录。UI 全局区仅放 readOnly，账号区放各自行为选项。

完整验收还需要在隔离 web 或影子 profile 中验证真实两账号、同号 uid 隔离、发送签名及 fromName。desktop profile 由 Electron 管理，不使用 CLI 向其安装开发插件。


## 使用工具绑定多个账号

`qqmail_config` 省略 account 修改默认账号；新增第二个必须明确 account:__new__，或使用 qqmail_accounts action:add。账号授权码通过本地安全输入传入，不写入命令历史或 Issue/PR。

```json
{"account":"__new__","id":"work","email":"you@example.com","preset":"qq-exmail"}
```

上述例子展示非凭据参数；新增时同时提供 authCode。BUPT 等企业/教育域名不自动猜服务商，腾讯企业邮箱显式选择 qq-exmail。

管理工具：qqmail_accounts 默认列出全部；action:setDefault + account 设置默认；action:remove + account + confirm:true 删除。qqmail_list/read/send/reply 等用 account:id或邮箱选择。所有工具说明包含 uid 的账号与文件夹作用域。旧单账号未指定 account 的输出保持兼容；多账号或显式选择时回显身份。

HTTP /accounts GET 列出、POST 管理；/config GET 只读（只接受账号选择），POST 修改。CLI 支持 --account，并通过 config --account __new__ 或 accounts add 新增；MCP 通过统一 ToolSpec 注册。客户端仍是单账号表单，当前请用工具或 CLI 管理。

运行中的宿主使用缓存；不要用独立 CLI 进程修改其同一配置后期待自动刷新。宿主运行时通过工具/HTTP 配置；离线 CLI 修改后重新启动该隔离 profile。跨进程并发写锁仍未实现。
