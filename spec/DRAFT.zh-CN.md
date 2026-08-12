# Agent Workflow Specification

状态：讨论草案，尚未批准，尚不构成兼容性承诺。

这份草案只规定 Agent Workflow 对外必须保证什么。当前 Codex + MCP 程序只是候选参考实现；模型、Agent 数量、角色名称、prompt、MCP、Git、worktree、SQLite 和文件格式都不由核心规范规定。

配套的普通中文考题见 [合规考题讨论稿](./CONFORMANCE-SCENARIOS.zh-CN.md)。

## 1. 规范用语

- **必须（MUST）**：合规实现不可违反。
- **不得（MUST NOT）**：合规实现禁止出现。
- **应该（SHOULD）**：通常应遵守；偏离时必须有可说明的理由。
- **可以（MAY）**：实现可自由选择。
- **实现定义（implementation-defined）**：实现可选择，但必须公开、稳定地说明其选择。

本规范不使用“未定义行为”逃避错误处理。无效输入、内部失败和不支持的能力必须产生明确结果。

## 2. 对外模型

```text
用户请求
  -> 直接回答；或
  -> 形成 Task Request
       -> Workflow Run
            -> Checkpoint 与 Evidence Reference
            -> 一个 Terminal Outcome
  -> 向用户交付结果
```

内部是否存在 Interaction Agent、Orchestrator、Worker、Verifier 或其它角色，属于实现定义。

## 3. 用户交互

**INT-001** 交互式实现必须保存用户已经确认的目标、约束和完成含义，不得在内部转交时静默丢失或改变。

**INT-002** 交互式实现不得要求用户协调内部 Agent、模型、工具、日志或执行顺序。

**INT-003** 实现只有在缺失信息会实质改变任务、风险或结果时，才应该要求用户补充信息；一次可以提出多个相关问题。

**INT-004** 不需要 Workspace 执行或持久状态的请求可以直接回答，不必创建 Workflow Run。

## 4. 接受任务

**RUN-001** 实现必须在修改 Workspace 或启动有副作用的执行前，形成并持久保存 Task Request。

**RUN-002** Task Request 必须至少表达：目标、实质约束、完成含义，以及允许使用的工作范围。

**RUN-003** 接受 Task Request 后，实现必须创建一个稳定的 Workflow Run 标识。

**RUN-004** 一个 Workflow Run 必须最终产生且只产生一个 Terminal Outcome。

## 5. 执行路线

**RTE-001** 使用一个还是多个模型、是否规划、是否采用 fast path，以及是否创建独立角色，都属于实现定义。

**RTE-002** 不同 Execution Route 必须满足相同的任务保存、Checkpoint、Verification、错误报告和 Terminal Outcome 要求。

**RTE-003** 当前路线无法可靠继续时，实现必须选择以下一种行为：内部升级路线、请求用户输入、报告阻塞、报告失败或响应取消。实现不得通过静默降低保证来继续。

## 6. Checkpoint 与恢复

**JRN-001** Workflow Run 必须保存有序、持久的 Checkpoint。

**JRN-002** Checkpoint 必须使后续执行能够知道：当前状态、已完成工作、仍然有效的关键决定、已有证据、下一步和未解决问题。

**JRN-003** 已提交的 Checkpoint 不得被静默修改或删除。后续修正必须保留原记录，并明确指出被修正的内容。

**JRN-004** 实现被中断后，必须能够从最后一个完整 Checkpoint 恢复；如果无法恢复，必须明确报告失败及不可恢复范围。

**JRN-005** Checkpoint 的存储格式、文件布局和持久化技术属于实现定义。

## 7. 证据与验证

**VER-001** Workflow Run 只有在完成含义得到 Evidence Reference 支持后，才能产生 `completed` 结果。

**VER-002** Verification 不得把执行者自己的“已经完成”声明当作完成证据。

**VER-003** Verification 可以由独立 Agent、独立上下文、确定性测试、人工确认或其它方法完成；具体方法属于实现定义。

**VER-004** 发现结果不满足 Task Request 时，实现必须修正、内部升级或返回非 `completed` 结果，不得隐瞒已知问题。

**VER-005** Task Request 和实现公开说明所要求的 Verification 全部完成前，Workflow Run 不得产生 `completed`。

**VER-006** Verification 可以异步运行；等待期间，实现可以继续不依赖验证结论且能够安全撤回或修正的内部工作。

## 8. 终态结果

Terminal Outcome 必须属于以下一种：

- `completed`：完成含义已经得到支持。
- `needs_input`：继续执行需要用户提供实质信息或作出决定。
- `blocked`：目标明确，但当前存在实现无法自行解除的外部阻塞。
- `failed`：执行或 Workflow Implementation 自身失败。
- `cancelled`：执行被明确取消。

**OUT-001** Terminal Outcome 必须包含面向用户的结论，并引用理解该结论所需的结果或证据。

**OUT-002** 内部异常、超时、Checkpoint 丢失、Verification 未完成或证据不足不得表示为 `completed`。

**OUT-003** 实现不得要求用户阅读内部 Agent 对话或原始日志才能理解 Terminal Outcome。

**OUT-004** 实现可以在 Terminal Outcome 产生前发送 Progress Update，但必须明确表示任务仍未完成，不得把它描述或展示为暂定的 `completed`。

## 9. 实现必须公开说明的内容

合规实现必须公开说明：

- 支持的 Specification 版本；
- 使用的输入、输出和状态 binding；
- Checkpoint 的持久化范围；
- Workspace 与副作用边界；
- Verification 方法和失败语义；
- 中断、恢复和取消能力；
- 资源使用统计是否可用，以及统计口径。

## 10. 合规性

实现只有在通过对应 Specification 版本的 conformance tests 后，才能声明合规。测试验证外部行为，不要求实现使用特定模型、Agent 拓扑、传输协议或存储技术。

当前仓库中的 Codex + MCP 程序在 conformance suite 建立并通过前，只称为“候选参考实现”。

## 11. 已解决的取舍（非规范说明）

Verification 不必阻塞实现内部继续推进，但必须阻塞最终 `completed`。实现可以发送明确的非终态进度；不得先向用户交付“暂定完成”，再要求用户等待第二次确认或纠正。

选择这一语义，是因为 provisional completion 会把跟踪验证状态、比较前后结果和处理纠正的协调成本转移给用户。

## 附录 A：当前候选参考实现差距（非规范）

本附录只记录当前实现与讨论草案的差距，不改变规范要求：

- 当前 `workflow.run` 已为 `single_worker` 单列 `completion_criteria`，但默认路线仍把约束与完成含义主要封装在自由文本 request 中，尚未形成完整、稳定的 Task Request 字段模型。
- 当前实现会在执行前保存任务并分配 Workflow ID，已经满足 RUN-001 与 RUN-003 的基本方向。
- 当前 Controller 已把语义边界提交到独立于 Workspace 的本地 Git，并拒绝静默改写已提交的 `task.md` / `result.md`；Codex 压缩生命周期 hook 与进程中断后的 Workflow 恢复仍未实现。
- 当前候选实现已有显式 `single_worker` fast path；Worker 请求升级或独立 Verification 拒绝结果时，会返回可机读的 Orchestrator 重试建议，由 Interactive Implementation 自动重试。Backend 尚不在同一个 Workflow Run 内续跑完整路线。
- 当前 SQLite 状态层会原子写入 Terminal Outcome 与对应事件，并拒绝后续终态覆盖；竞争信号的完整 conformance 测试仍未建立。
- 当前 `usage` 汇总每个 Agent thread 的最新累计 SDK usage snapshot；同一 thread 恢复后的新 snapshot 会替代旧 snapshot。`input_tokens` 因而包含多轮工具调用重复处理或命中缓存的上下文，不等于唯一上下文大小。
- 当前完成路径使用 fresh-context Verification，但尚未形成与实现无关的合规测试。
- 当前 Terminal Outcome 没有 `cancelled`。
- 当前没有 Specification 版本声明、implementation-defined choices 清单或 conformance suite。
