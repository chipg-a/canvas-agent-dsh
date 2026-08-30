# canvas-agent

基于 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) v0.1.0-rc.5 的**画布式 Agent 交互层**：把 DSH 的线性聊天界面升级为「画布即交互界面」——节点画布、任务拆解建议、工作流可视化执行、定时调度，全部以 DSH 原生能力为底座，只换交互形态，不阉割任何功能。

> 这是一个二开（overlay）项目，不是独立应用。它把 deepseek-harness 的 checkout 原地改造成画布形态；上游源码不属于本仓库，请从官方获取。

## 特性

- **画布即会话**：每个工作空间（会话）一块画布，节点自由拖拽、缩放/平移、框选批量操作、搜索定位、分支树展示。
- **任务拆解建议**：Agent 自动拆解根任务，画布上确认/放弃/合并。
- **工作流可视化执行**：Agent 设计多步工作流（含依赖关系与需人工输入的步骤），确认后按依赖顺序自动执行；依赖未完成不提前触发；输入步骤右栏等待你的输入；支持模板重跑与产物汇总修改。
- **定时调度**：工作流可一键交给 DSH 的 schedule 定时执行。
- **完整原生输入**：画布右栏是原生 composer 的完整形态——权限选择、附件、Plan 模式、模型选择、斜杠命令菜单、队列/待办/目标条、统计行，一个不缺。
- **输入点明确**：右栏就是原生对话流 + 原生输入框；节点是"在新对话中分支"按钮，点击后右栏切到该节点（fork）的对话继续聊；工作流等待输入时右栏自动滑出，提问直接在右栏输入框上方显示，绝不藏起来。

## 设计原则

1. 画布是会话的投影，不是另一份数据。
2. 模型可见的 ⟺ 已记录的（会话事件溯源，刷新/回放一致）。
3. 默认隔离、按需引用（节点之间的 fork 分支即隔离）。
4. 确认是执行决策，不是审批（不做审批流）。
5. 被动触发：画布不主动打扰，等待输入有保底提示。
6. 不引入外部集成机制：执行与定时全部复用 DSH 的 workflow / schedule。
7. 产出有归属：每个产物可回溯到产出它的节点，可一键跳回修改。
8. 功能不阉割：所有原生 DSH 能力原样保留，只换显示形式。

## 安装

前置要求：Node.js ≥ 22、pnpm ≥ 9，以及一个 **deepseek-harness v0.1.0-rc.5 的检出**（已经跑过 `pnpm install` 的官方源码目录）。

### 从下载到运行的完整步骤（Windows）

```text
1. 下载本仓库：GitHub 页面点 Code → Download ZIP，解压到任意目录（比如 C:\canvas-agent）。

2. 打开 PowerShell（开始菜单搜 PowerShell，或在解压文件夹空白处 Shift+右键 → "在终端中打开"），
   执行这一行（把路径换成你的解压位置）：
   powershell -NoProfile -ExecutionPolicy Bypass -File C:\canvas-agent\install.ps1

3. 脚本提示 "Type the full path of your deepseek-harness folder" 时，
   输入你 DSH 检出的完整路径（含 pnpm-workspace.yaml 的那个目录），回车。
   例如：C:\work\deepseek-harness

4. 脚本自动完成：复制 3 个新包 → 覆盖 25 个上游文件 → pnpm install → 构建。
   看到 "Done. Your DSH is now the canvas deployment." 即安装成功。

5. 启动：
   cd C:\work\deepseek-harness
   pnpm dsh web --port 3090
   浏览器打开 http://127.0.0.1:3090
```

命令行方式（可选，效果相同，需要 PowerShell 允许执行脚本）：

```bash
git clone https://github.com/<你的账号>/canvas-agent.git   # 或解压 zip
cd canvas-agent
.\install.ps1 -DshPath C:\work\deepseek-harness            # PowerShell
```

**安装会原地修改你的 DSH 检出**（这是二开 overlay 的既定行为）。需要还原时，用 `git checkout` 还原被覆盖的文件，并删除 `packages/canvas/*` 与 `packages/client/ui-canvas`。

### 常见问题

- **提示"禁止运行脚本"**：用上面的 `powershell -ExecutionPolicy Bypass -File ...` 方式（已自带绕过），不要直接 `.\install.ps1`。
- **提示 DSH 版本不是 v0.1.0-rc.5**：本 overlay 基于该版本构建，其他版本可能不兼容（脚本会警告但继续，若构建失败请换成 v0.1.0-rc.5 检出）。
- **pnpm install 很慢或失败**：网络/镜像问题，配置 pnpm 镜像后重跑即可；覆盖过的文件重复执行安装是安全的（幂等）。
- **构建失败**：按脚本最后的红色提示排查（版本不符 / pnpm 不在 PATH / DSH 被其他东西改过）。
- **不需要 git**：下载 ZIP 即可安装，只有"以后想还原被覆盖的上游文件"时才需要 DSH 检出本身带 git。

## 使用

- 新工作空间 = 新画布；空白会话先显示工作区选择器，第一条消息后节点出现。
- 节点就是原生"在新对话中分支"按钮：单击节点 → 右栏切到该节点（fork）的对话，可以继续对话，继续的内容在画布该节点下生成子节点；画布和左侧栏都不切换、不新建。双击空白新建根任务；单击某会话的最后一个节点 = 在该会话内继续。
- 选中或悬停节点卡片，卡片上直接浮出操作条：确认 / 固定 / 删除 / 命名（图标按钮）；拖拽卡片后位置持久化，刷新不重置。
- 顶部工具栏：大纲开关、右栏开关（收起时画布全宽）、搜索、适应/缩放。
- 右栏 = 原生对话流 + 输入框；工作流确认、任务建议、工作流产物都以卡片形式嵌在对话流末尾，确认/放弃/定时/全部确认直接操作。
- 待审批 / 提问：Agent 需要审批或提问时，右栏输入框上方直接显示卡片——审批可"允许一次 / 拒绝"，提问可选选项或输入回答提交，无需切换 tab。
- 工作流：点"3 步工作流"标识 → 右侧栏确认 → 画布出现占位卡片与依赖箭头，自动按依赖顺序执行；带输入标记的步骤停在右栏等你输入。
- 定时：工作流面板里填写定时描述（如"每天早上 9 点"），交给 DSH schedule 执行。

## 本仓库结构（全部为增量代码）

```
packages/canvas/canvas-projection/    画布投影（会话事件溯源）、CanvasTrees Remote 服务、画布事件
packages/canvas/tool-canvas-reference/  画布工具（列出/引用节点、任务与工作流建议）
packages/client/ui-canvas/            画布 UI（CanvasView：画布/大纲/右栏/工作流执行器/提问卡片）
patches/                              被修改的上游文件（35 个，路径与 DSH 一致）
install.ps1                           一键安装脚本
```

被修改的上游文件覆盖 `packages/api/remotes`（canvasTrees Remote 挂载）、`packages/client/modules` 与 `packages/client/web`（client 配置透传）、`packages/client/runtime`（sessions 新增 `openRail`：打开会话窗口但不切换当前选择——右栏 fork 视图的地基）、`packages/client/ui-conversation`（画布视图接入 + composer 右栏 + 会话状态 + 右栏对话流）、`packages/client/ui-model-selection`（窄栏模型选择压缩）、`packages/bundle/base`（canvas-projection host 挂载）、`packages/bundle/web-app`（画布部署配置：`chatView: false` + schedule 挂载）、`apps/cli/config/agent-presets/standard`（画布工具挂载）。

## 许可

- **本仓库（增量部分）：GPL-3.0-only**。商用分发本 overlay 的衍生品必须开源并保留版权声明（见 [LICENSE](LICENSE)）。
- **上游 deepseek-harness：MIT**（Copyright 2026 DeepSeek）。上游代码不属于本仓库，请从官方获取；使用本 overlay 时请遵守上游许可（保留其版权声明）。
- 会话数据与配置存储在 `~/.dsh/`（凭据、会话日志、设置），不在本仓库内，请勿提交。

## 已知限制

- 线性聊天 tab 已移除（`chatView: false` 是本 overlay 的部署决定）：逐条消息流与工具调用过程在「轨迹」tab 查看，画布显示节点摘要。
- 画布只在前端渲染；执行与调度由 DSH 的 workflow / schedule 负责，本 overlay 不引入新的执行机制。
