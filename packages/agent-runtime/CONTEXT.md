# Agent Runtime

该上下文描述由外部 Agent 执行、由宿主校验和持久化的推理工作。

## Language

**External Inference Job**:
宿主准备的、可被外部 Agent 延迟执行的一份有界推理工作。
_Avoid_: LLM request, chat task

**Inference Worker**:
领取 External Inference Job 并提交结构化候选结果的外部 Agent。
_Avoid_: provider, model client

**Worker Lease**:
Inference Worker 在有限时间内处理一份工作的独占资格；租约到期不表示工作成功。
_Avoid_: lock, ownership

**Result Submission**:
Inference Worker 返回的结构化候选结果；在 Host Commit 前一律不可信。
_Avoid_: completed result, database write

**Host Commit**:
宿主对 Result Submission 完成校验、归属映射和持久化后的权威结果。
_Avoid_: worker write, direct import

**Execution Channel**:
用户选择的 Agent 软件及其执行入口，不属于 MyContext 的持久化领域。
_Avoid_: provider-specific mode
