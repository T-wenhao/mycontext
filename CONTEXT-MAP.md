# Context Map

## Contexts

- [Agent runtime](./packages/agent-runtime/CONTEXT.md) — 管理外部推理工作的领取、租约与结果提交
- [Distillation](./packages/distill/CONTEXT.md) — 从消息中生成可复用的工作知识
- [Knowledge graph](./kl-graph/CONTEXT.md) — 从 Extraction Item 生成带来源的实体与事实

## Relationships

- **Distillation → Agent runtime**：蒸馏发布外部推理工作并消费已提交结果。
- **Knowledge graph → Agent runtime**：图谱抽取的模型调用经 Agent runtime 的 chat broker 代理为外部推理任务；抽取结果仍由图谱管线解析、校验并入库。
- **Agent runtime → Host**：外部推理只返回候选结果，校验和持久化始终由宿主完成。

只读取与当前任务相关的 context。其他 context 文档由领域建模流程按需创建。
