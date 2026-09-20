# 图谱抽取与主模型调用经 chat broker 改道外部 Agent

T02 之前，外部推理只覆盖蒸馏的 `tasks` Facet；kl 建图 Phase B 的实体/事实
抽取直连模型网关，主模型（搜索、数字分身、蒸馏 LLM 调用）同样直连。网关的
账户级并发限流（429）与本地小模型的推理挂死使这两条路在真实数据上不可靠。
用户决定：知识库抽取与主模型调用常态化由外部 Agent 执行，模型网关仅作兜底。

## Decision

Agent runtime 的 MCP server 新增 `POST /v1/chat/completions` broker 路由
（独立 purpose credential、拒绝浏览器 Origin、与 /mcp 相同的体积上限）：

- kl 建图 Phase B 的每次 litellm 抽取调用打到该路由，broker 把请求体发布为
  `graph-extraction` 外部 Job（幂等键 = messages 哈希 + 进程盐），阻塞等待
  worker 经 claim/submit 提交补全文本，校验通过后原样以 OpenAI 补全形状返回
  给调用方。kl 与主模型消费方零改动——仅 env/配置指向 broker。
- 主模型（llmHolder 与 opencode 内联 provider）与 KL 抽取的网关地址在 vault
  挂载时由启动逻辑刷新为 broker 端点；设置里的主模型/知识库抽取由此固定为
  外部 Agent。
- 抽取请求原文与补全文本只存 broker 进程内存（与 kl 在途 HTTP 连接同生命
  周期）；外部 Job 队列行只保留元数据。应用重启后换盐重发布，孤儿 Job 走
  skip 出队，由调用方重试。

被否决的替代方案：按 issue #1 原始设想由桌面读取 kl 的 Extraction Item 并
发布任务——需要 kl 侧配合暴露/暂停抽取批次，改动面大；端点替换方案以零
kl 改动达成同一效果（外部 Agent 执行推理，宿主拥有校验与持久化）。

## Consequences

- 无 worker 在线时，Phase B 单批等待约十五分钟后失败（可见、可重试）；
  建图在该窗口内停等是设计行为，不是缺陷。
- worker 提交的补全文本视为不可信输入，仍走 kl 原有的 JSON 解析与领域校验；
  来源（provenance）由建图管线自己维护。
- broker 端口每次 attach 动态分配；vault 挂载时把存储覆盖刷新到当前端口，
  设置页显示的是兜底网关而非 broker——已知的显示语义。
- 调用方的批处理超时必须大于 worker 的推理时延（`KL_LLM_BATCH_TIMEOUT`），
  且限流类失败由调用方重试；重试因幂等键会落回同一 Job。
