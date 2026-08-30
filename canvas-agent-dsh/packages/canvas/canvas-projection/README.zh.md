# @deepseek-ai/dsh-canvas-projection

[English](README.md) | 中文

画布 Agent 的投影层：把一个会话的事件日志折叠成它的画布节点列表（输出 = 节点，用户确认/固定/删除决策生效），并把会话 lineage 与各会话节点列表折叠成完整的跨会话画布树。插件在会话投影缝上注册 `canvasTree` 投影单元；折叠函数是纯函数，可直接测试。

`canvasTreeProjectionDefinition` 是一个 `ProjectionDefinition<'canvasTree'>`：`turn/start` 打开一个轮次，轮次内的 `assistant/message` 记录输出，`turn/end` 物化节点（没有组装出输出的轮次不产生节点）。`canvas/node-commit` / `canvas/node-pin` / `canvas/node-remove` 会话事件应用用户决策：commit 使待确认节点定稿（按输出 seq 键控），pin 将其标记为可引用，remove 将其从视图摘除而日志事件保留。每个无关事件都返回同一状态引用，因此注册表的 `Object.is` 门会跳过下游工作。`projectCanvasTree(events)` 是供测试与回放使用的纯入口。

`foldCanvasTree(sessions)` 构建跨会话树：主干是唯一没有 `parentSessionId` 的会话，fork 子节点经 lineage 递归挂接，lineage 环或多个主干会被拒绝。父会话不在输入中的会话会被剔除（它们属于另一个画布或语料库）。跨会话树要求画布显式标识其主干会话——一个 workspace 可能持有多个独立会话，因此"无父"本身不足以确定主干（见设计文档）。

`canvas/node-*` 事件仅记录日志：输出本身已经以 `assistant/message` 的形式出现在表面上，因此记录展示决策即可满足"模型可见 ⟺ 已记录"，无需新增表面事件。

## 模型体验

无：本包只拥有对会话事件的纯折叠，不触达任何模型请求。

### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与待办

- **尚无画布树 host 服务。** 跨会话折叠以纯函数导出；通过 RPC 暴露它（携带 workspace 的主干会话 id）的 host 服务推迟实现。
- **`canvas/*` 事件尚无生产者。** 折叠会应用它们，但追加这些事件的用户端控件（画布 UI 中的确认/固定/删除操作）推迟实现。
