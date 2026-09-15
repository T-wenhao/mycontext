# Domain docs

本仓库采用 multi-context 领域文档布局。

## Reading rules

开始修改前：

1. 读取根目录 `CONTEXT-MAP.md`。
2. 读取与修改范围对应的 `CONTEXT.md`。
3. 读取 `docs/adr/` 中相关的系统级决策。
4. 如模块存在局部 ADR，再读取该模块的 `docs/adr/`。
5. 如果文档不存在，继续工作；仅在领域术语或长期决策需要固化时创建。

新增任务、测试和代码应沿用领域文档定义的术语。若实现与现有 ADR 冲突，必须
显式指出，不得静默覆盖。
