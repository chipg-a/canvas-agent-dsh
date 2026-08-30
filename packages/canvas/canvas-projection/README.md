# @deepseek-ai/dsh-canvas-projection

English | [中文](README.zh.md)

The projection layer of the canvas agent: folds one session's event log into its canvas node list (outputs = nodes, user commit/pin/remove decisions applied) and folds session lineage plus per-session node lists into the whole cross-session canvas tree. The plugin registers the `canvasTree` projection unit on the session-projection seam; the fold functions are pure and directly testable.

`canvasTreeProjectionDefinition` is a `ProjectionDefinition<'canvasTree'>`: `turn/start` opens a turn, an in-turn `assistant/message` records the output, `turn/end` materializes the node (a turn with no assembled output produces none). The `canvas/node-commit` / `canvas/node-pin` / `canvas/node-remove` session events apply user decisions: commit settles a pending node (keyed by output seq), pin marks it referenceable, remove drops it from the view while the log events stay. Every uninteresting event returns the same state reference, so the registry's `Object.is` gate skips downstream work. `projectCanvasTree(events)` is the pure entry point for tests and replay.

`foldCanvasTree(sessions)` builds the cross-session tree: the trunk is the one session without a `parentSessionId`, fork children attach recursively via lineage, and a lineage cycle or several trunks is rejected. Sessions whose parent is outside the inputs are dropped (they belong to another canvas or corpus). The cross-session tree requires the canvas to identify its trunk session explicitly — a workspace may hold several independent sessions, so "no parent" alone is not the trunk (see the design document).

The `canvas/node-*` events are log-only: the output itself is already on the surface as its `assistant/message`, so recording the display decision satisfies "model-visible ⟺ logged" without a new surface event.

## Model Experience

None: the package owns pure folds over session events; nothing here reaches a model request.

### KV Cache effect

None; the package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No canvas-tree host service yet.** The cross-session fold is exported as a pure function; a host service exposing it over RPC (with the workspace's trunk session id) is deferred.
- **The `canvas/*` events have no producers yet.** The fold applies them, but the user-facing controls that append them (confirm/pin/remove actions in the canvas UI) are deferred.
