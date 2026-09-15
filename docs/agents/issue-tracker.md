# Issue tracker

规格、实施任务和缺陷记录在 origin 远端仓库的问题跟踪器中，通过 `gh` CLI 操作。

## Conventions

- 使用 `gh issue create` 创建规格或任务。
- 使用 `gh issue view <number> --comments` 读取完整上下文。
- 使用 `gh issue edit` 管理标签和负责人。
- 使用 `gh issue comment` 记录证据和实施结果。
- 使用 `gh issue close` 关闭已验收任务。
- 本仓库不把外部 PR 自动视为待分流请求。
- 实施任务必须写明验收标准、测试接缝和 blocking edges。
- 没有未关闭 blocker 且带有 `ready-for-agent` 标签的任务，才可以交给 Agent 实施。
