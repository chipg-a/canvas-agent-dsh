# @deepseek-ai/dsh-client-ui-canvas

English | [中文](README.zh.md)

Canvas-agent view: contributes a **画布** tab to the conversation view ring (`conversation.view`, `order: -10` so it leads the ring) that renders the session's canvas node tree as a free-positioned mind-map surface. The browser half registers the view; the node data comes from the host `canvasTree` projection through the slot's standard `useProjection` seat. Removing its one cordis.yml entry removes the tab.

`CanvasView` reads the `canvasTree` projection key: one node per agent output turn, in turn order, with the node's turn boundary (`startSeq`/`endSeq`), its `outputSeq`, lifecycle `state` (`settled`/`pending`), and a three-line text preview. Pending nodes (outputs awaiting the user's confirm-to-canvas decision) render with an amber border and a 待确认 badge; pinned nodes carry a 📌 marker. When the projection key is absent the view shows a not-mounted hint; when the session has produced no outputs it shows an empty hint.

The surface is a real canvas: free node positioning with drag, zoom/pan (`F`/toolbar fit-all, wheel), marquee selection (Shift+drag) with a batch action bar, search with highlight-and-fly-to, fork-branch rendering from the loaded session tree, and a right rail that hosts the native composer (`hostsComposer` + `hideComposer`) plus node details. Double-clicking empty space creates a root task; double-clicking a node opens its details and routes the rail composer's submission to that node (fork target), so the canvas is itself an input surface.

Workflow plans are first-class: the agent can propose a structured workflow (`canvas/suggest-workflow` — nodes plus dependency edges, optional `input` steps); the user confirms or discards it. An adopted plan (`canvas/workflow-adopt`) renders as placeholder cards with dependency arrows, and the client drives dependency-ordered execution: a step sends its root prompt only after every dependency is realized (a real root node with that prompt exists), input steps stop at the rail for the user's per-run value, the plan re-runs from the toolbar badge, and realized outputs collect in a results summary that opens the producing node for modification. Execution is presentation-side: prompts go through the native `sessions.prompt` queue and the plan is durable session data, so refresh and re-adopt keep the plan.

The view is pure presentation. It never imports the host projection package's type declarations (they merge host session modules and live in the host compile program); the client mirrors the wire payload with its own local view types. Node decisions (`canvas/node-commit` / `node-pin` / `node-remove` / `canvas/suggest-*` / `canvas/workflow-*`) are session-log events owned by `@deepseek-ai/dsh-canvas-projection`; this package only renders their projection and calls the `canvasTrees` Remote for user decisions.

## Model Experience

None: the view renders the session's canvas projection and reaches no model request.

### KV Cache effect

None; the canvas view neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Node positions are not durable.** Drag positions (`moved`) live in component state and reset on refresh; persisting them to the session log is deferred.
- **Canvas hides the linear transcript.** With `chatView: false` the chat tab is absent; the full message transcript and tool-call details live in the trajectory tab, and pending approval/question takeovers answer there (the bottom composer seat is hidden while the canvas tab is active).
- **Single-workflow plans per view.** Cross-workflow chaining (one workflow's outputs seeding another's inputs) is deferred; each adopted plan executes independently.
