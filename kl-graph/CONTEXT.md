# Knowledge Graph

该上下文描述从来源材料建立可追溯实体、事实和关系的过程。

## Language

**Extraction Item**:
由来源处理策略确定的独立推理目标；它不是图节点，旁邻内容只提供上下文。
_Avoid_: chunk, graph node

**Extraction Result**:
一份 Extraction Item 对应的实体与事实候选集合，在图谱提交前一律不可信。
_Avoid_: graph update, final facts

**Extraction Projection**:
Extraction Item 与其证据 Chunk 之间的归属关系。
_Avoid_: duplicate extraction

**Graph Commit**:
图谱宿主校验 Extraction Result，并把实体、事实与来源关系写入当前构建轮次后的权威结果。
_Avoid_: worker write, direct graph mutation
