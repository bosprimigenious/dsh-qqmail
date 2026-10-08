# 多账号核心开发与评审

关联上游 Issue #1。本阶段实现设计草案的第 1–4 步，供评审核心接口；尚未接入多账号工具参数、账号管理工具、路由、UI 和 CLI/MCP。完整改造状态为 **NOT READY**。

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

本机 typecheck/build 和全部测试通过。直接 verify 在 npm 12 的 pack JSON 解析处失败；使用 npm 11 重跑后，DSH 0.2.0-rc.2 拒绝上游原有 peerDependencies，后续健康检查 401、客户端未交付、稳定性健康检查失败。未修改的上游基线也复现相同四项失败。因此本阶段只提交 Draft PR，不能发布或安装到正在使用的 desktop。

真实 v1 配置仅复制到 0600 临时文件做离线差分：默认 view、Account 旧字段及 12 个工具的空参数离线响应与旧版字节一致，迁移备份匹配原字节，真实配置内容与 mtime 不变。这不代表真实收发邮件的所有响应都已逐字节验证。

## 后续评审门禁

先评审本阶段，再接入 qqmail_accounts、各工具 account 参数与 uid 作用域说明、routes、UI、CLI/MCP。多账号默认附件目录拟为 `<dataDir>/attachments/<accountId>/`；旧单账号下载路径兼容规则仍需明确。UI 全局区仅放 readOnly，账号区放各自行为选项。

完整验收还需要解决宿主兼容与 verify 门禁，并在隔离 web 或影子 profile 中验证真实两账号、同号 uid 隔离、发送签名及 fromName。desktop profile 由 Electron 管理，不使用 CLI 向其安装开发插件。
