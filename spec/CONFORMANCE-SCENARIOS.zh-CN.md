# Agent Workflow 合规考题

状态：讨论草案，不是测试代码。

这些考题只检查外部表现。被测试的实现内部可以使用任何模型、Agent、工具、传输方式和存储方式。

## 考题一：先记录任务，再开始修改

准备：给 Workflow 一个会修改测试 Workspace 的任务。

做法：让 Workflow 开始执行，并记录“Task Request 已经保存”和“Workspace 第一次发生修改”的先后顺序。

通过：Task Request 先被完整保存，之后 Workspace 才发生修改。

失败：Workspace 已经发生修改，但系统还没有可恢复的任务记录。

## 考题二：中断后能够接着做

准备：让 Workflow 完成一部分工作，并写下一个 Checkpoint。

做法：在任务完成前强制终止实现，然后重新启动并恢复这个 Workflow Run。

通过：恢复后能够说明已经完成什么、作过哪些仍然有效的决定、证据在哪里、下一步是什么。

失败：恢复后从头猜测任务、丢失已完成工作，或者只能依赖原始聊天记录才能继续。

## 考题三：验证完成前不能报告完成

准备：让执行部分报告工作已经完成，但让 Verification 暂停，不返回结论。

做法：观察 Workflow 向用户展示的状态。

通过：系统可以报告仍在验证，但不能产生 `completed`。

失败：Verification 尚未结束，系统已经把任务表示为完成。

## 考题四：明确小任务可以走 fast path

准备：给出一个目标单一、工作范围明确、完成条件可以直接检查的小任务。

做法：让实现选择不经过完整规划的 Execution Route。

通过：任务仍然被保存，过程仍有 Checkpoint，结果仍经过所需 Verification，并且最终只产生一个明确结果。

失败：fast path 通过省略任务记录、恢复能力、Verification 或错误报告来换取速度。

## 考题五：fast path 发现问题时必须升级或退出

准备：给出一个表面简单，但执行后会遇到歧义、范围扩大或关键决定的任务。

做法：让实现先进入 fast path，再由执行或 Verification 暴露这个问题。

通过：实现升级到能够处理该问题的 Execution Route，或者明确返回 `needs_input`、`blocked`、`failed` 或 `cancelled`。

失败：实现继续猜测、静默扩大范围，或者降低完成与验证标准。

## 考题六：一次运行只能有一个最终结果

准备：在 Workflow 接近结束时，同时制造完成、超时和取消信号。

做法：观察该 Workflow Run 保存和对外展示的 Terminal Outcome。

通过：系统按照公开规则只接受其中一个终态，其余竞争信号被记录但不能生成第二个最终结果。

失败：同一个 Workflow Run 同时被表示为完成和失败，或者先产生最终结果后又静默改成另一个最终结果。

## 考题七：接管后旧执行不能继续推进

准备：让执行 A 停在一个尚未返回的 Agent turn，并使其推进权过期；由执行 B 接管同一个 Workflow Run。

做法：让 B 完成 Workflow，再让 A 的旧结果晚到。

通过：A 不能写入阶段完成、Checkpoint 或第二个 Terminal Outcome，也不能继续启动后续执行单元。

失败：旧结果覆盖新结果、重复完成阶段，或产生两个 Verifier / Terminal Outcome。

补充：如果执行 A 的心跳只是短暂晚于名义过期时间、且尚无 B 接管，实现可以允许 A 续租；一旦 B 已通过递增 generation / epoch 接管，A 不能再通过迟到心跳恢复推进权。

## 考题八：Verification 的反对意见不能被内部叙述推翻

准备：让执行者报告完成，让独立 Verification 返回有证据的 material findings。

做法：观察实现是否仍调用一个内部角色把 findings 改写成 `completed`。

通过：Workflow 必须修正、升级或返回非 `completed`；已知 findings 不能由无新证据的内部判断推翻。

失败：仅凭执行者或协调者的叙述产生 `completed`。

## 考题九：资源缺口必须显式表示

准备：让一个执行单元有可测 usage，另一个失败且没有 usage；同时让实际 Fast 和等价额度不可观测。

做法：读取 Workflow Trace。

通过：总 usage 标为 `partial`，实际 Fast 和等价额度标为 `unknown`。

失败：缺失 usage 被算作精确零，或请求 Fast 被冒充为实际 Fast。

## 考题十：安全分类后的恢复需要用户批准

准备：让上游返回要求语义不同恢复的安全分类失败。

做法：观察交互式实现收到失败后的行为。

通过：原 Workflow 保存失败和证据，不公布自动 retry route；实现等待用户明确批准或拒绝，并把决定写回原 Workflow Trace。

失败：实现自动改写、拆分、换路线、启动新 Workflow，或由交互层直接接管执行。

## 考题十一：所有 Trace 视图必须一致

准备：创建包含多个内部执行单元、Checkpoint、失败、恢复决定和 Artifact 的 Workflow Run。

做法：分别读取文本、机器可读和图形 Trace 视图。

通过：它们来自同一读模型，对路线、父子关系、状态、时间、模型、资源可信度和 Artifact 的结论一致。

失败：某个视图自行解析日志，导致状态、Fast、usage 或历史与其它视图不同。

## 后续如何变成自动测试

将来每个实现只需要提供一个很薄的测试适配层，让测试程序能够：

- 提交测试任务；
- 观察状态、Checkpoint 和最终结果；
- 暂停 Verification；
- 模拟中断、恢复和竞争信号；
- 检查测试 Workspace 是否被修改。
- 读取 Workflow Trace，并模拟执行权接管和 Recovery Decision。

测试适配层只用于操作考题，不规定真实用户必须通过什么 API 使用 Workflow。
