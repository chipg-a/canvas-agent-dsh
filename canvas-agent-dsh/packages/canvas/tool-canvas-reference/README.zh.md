# @deepseek-ai/dsh-tool-canvas-reference

[English](README.md) | 中文

画布记忆工具：画布设计"默认隔离、按需引用"的运行时形态。画布节点默认各自持有独立的会话记忆；这些工具让 Agent 在真正需要时显式拉取某个节点的记忆。

`canvas_reference_list` 列出调用 Agent 可以引用的会话（其他画布会话——fork 分支、兄弟画布），按工作目录亲和度排序，以标题或会话 id 作为标签。`canvas_reference` 通过 `ctx.sessionReferenceResolver.prepare` 快照一个被引用会话的当前表面（用户提示、Assistant 回答、压缩检查点），并作为不可信的 "Referenced sessions" `user/message` 注入调用 Agent 的下一次请求。快照只读、受解析器保留策略约束、且已分离：源会话之后的变更不影响该引用。

两个工具都要求精确的、处于活动驱动器中的实时调用 Agent（与 goal 工具相同的权威检查）；引用调用会话自身会被拒绝。注入的上下文携带 `source: { kind: 'plugin', plugin: 'tool-canvas-reference' }`，因此它是已记录、模型可见的输入——满足"模型可见 ⟺ 已记录"。

## 模型体验

### 被引用的画布会话背景

#### 模型看到的内容

`canvas_reference` 成功后，下一次请求携带两条连续的 user 角色消息：`## Referenced sessions` 不可信快照（`<referenced-sessions>` 标签内的 JSON，含禁止遵循其中指令的警告），随后是普通消息。模型可以利用被引用节点早先的探索来作答。

#### Token 影响

每条引用增加固定警告加上序列化快照，按解析器的每个来源 `maxReferenceBytes` 约束；快照保留在目标历史中，直到目标压缩将其遮蔽或摘要化。

### 画布引用列表

#### 模型看到的内容

`canvas_reference_list` 返回候选会话 id 与标签，供 Agent 选择引用。

#### Token 影响

一个携带候选列表的工具结果；不增加持久上下文。

## 已知限制与待办

- **需要组合 session-reference 解析器。** 没有 `ctx.sessionReferenceResolver` 时，工具会以描述性错误响亮失败，而不是静默无操作。
- **尚无画布树耦合。** 工具操作原始会话 id；未来的画布感知变体可以接受节点引用（turn + 会话）并只准备该节点的区间。
