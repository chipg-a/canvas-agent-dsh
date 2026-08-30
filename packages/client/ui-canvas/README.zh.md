# @deepseek-ai/dsh-client-ui-canvas

[English](README.md) | 中文

画布式 Agent 视图：为会话视图环（`conversation.view`）贡献一个**画布**标签页，把会话的画布节点树以思维导图风格的节点列表渲染出来。浏览器侧注册视图；节点数据通过 slot 的标准 `useProjection` 席位读取 host 的 `canvasTree` 投影。删除它在 cordis.yml 中的那一行即可移除该标签页。

`CanvasView` 读取 `canvasTree` 投影键：每个 Agent 输出轮次一个节点，按轮次顺序排列，携带节点的轮次边界（`startSeq`/`endSeq`）、`outputSeq`、生命周期 `state`（`settled`/`pending`）以及三行文本预览。待确认节点（等待用户确认是否进入画布的输出）以琥珀色边框和「待确认」徽标渲染；已固定的节点带 📌 标记。投影键缺席时视图显示未挂载提示；会话尚无输出时显示空提示。

该视图是纯展示。它从不导入 host 投影包的类型声明（那些声明合并了 host 会话模块，位于 host 编译程序中）；client 用本地视图类型镜像 wire 载荷。节点决策事件（`canvas/node-commit` / `node-pin` / `node-remove`）是归 `@deepseek-ai/dsh-canvas-projection` 所有的会话日志事件；本包只渲染它们的投影。

## 模型体验

无：该视图渲染会话的画布投影，不触达任何模型请求。

### KV Cache 影响

无；画布视图既不组装也不发送 provider 请求。

## 已知限制与待办

- **列表渲染，尚未是画布。** 视图以滚动卡片列表渲染节点；思维导图布局（自由定位、缩放/平移、fork 树渲染）推迟到画布表面前期里程碑。
- **仅会话内节点。** 视图展示所选会话的 `canvasTree` 投影；跨会话 fork 树（经会话 lineage 的主干 + 分支）需要 host 端点，推迟实现。
- **尚无节点操作。** 确认/固定/删除决策已定义为会话事件，但视图尚未派发它们；接入控件推迟实现。
