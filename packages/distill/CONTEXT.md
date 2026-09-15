# Distillation

该上下文描述从用户授权消息中提炼可复用工作知识的过程。

## Language

**Distillation Task**:
针对一个来源范围、时间窗和知识 Facet 的可恢复提炼工作。
_Avoid_: batch request, prompt

**Facet Candidate**:
从一份 Distillation Task 产生、尚未通过宿主校验和合并的候选知识。
_Avoid_: final facet, model output

**Work Layer**:
由已提交的 Facet Candidate 合并生成、供宿主能力按授权读取的工作知识层。
_Avoid_: memory dump, raw transcript
