# 外部 Agent 只执行推理，宿主拥有校验与写入

MyContext 允许 External Inference Job 携带用户已授权范围内的真实内容，由用户选择的
Inference Worker 延迟执行，以复用该执行渠道可用的模型额度。Inference Worker 不获得
vault、数据库路径或直接写权限；Result Submission 始终视为不可信输入，只有宿主能够
完成证据映射、规则校验、合并以及 Host Commit。外部执行失败时保持可重试状态，不自动
回退到其他可能产生费用的执行渠道。

## Consequences

- 真实内容只通过运行时任务接口按工作范围提供，不进入仓库、Issue、测试数据或诊断日志。
- 宿主在领取、提交和提交后处理期间必须保持可访问；任务状态需要跨进程重启持久化。
- 推理渠道和模型不是持久化领域的一部分，协议与 Skill 使用能力中性名称。
- 图谱继续保留 Extraction Item、缓存、checkpoint 与单写者语义。
