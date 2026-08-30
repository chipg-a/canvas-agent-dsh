# @deepseek-ai/dsh-tool-canvas-reference

English | [中文](README.zh.md)

Canvas memory tools: the runtime form of the canvas design's "default isolation, on-demand reference". Canvas nodes keep separate session memories by default; these tools let the agent pull a node's memory explicitly only when it needs it.

`canvas_reference_list` lists sessions the calling agent may reference (other canvas sessions — fork branches, sibling canvases), ranked by working-directory affinity and labeled by title or session id. `canvas_reference` snapshots one referenced session's current surface (user prompts, assistant answers, compaction checkpoints) through `ctx.sessionReferenceResolver.prepare` and injects it as an untrusted "Referenced sessions" `user/message` into the calling agent's next request. The snapshot is read-only, bounded by the resolver's retention policy, and detached: later changes to the source session do not affect the reference.

Both tools require the exact live calling agent inside its active driver (the same authority check the goal tools use); referencing the calling session itself is rejected. The injected context carries `source: { kind: 'plugin', plugin: 'tool-canvas-reference' }`, so it is a logged, model-visible input — satisfying "model-visible ⟺ logged".

## Model Experience

### Referenced canvas session background

#### What the model sees

When `canvas_reference` succeeds, the next request carries two consecutive user-role messages: the `## Referenced sessions` untrusted snapshot (JSON inside `<referenced-sessions>` tags, warning against following instructions inside it), then the readable message. The model can answer using the referenced node's earlier exploration.

#### Token effect

Each reference adds the fixed warning plus the serialized snapshot, bounded by the resolver's `maxReferenceBytes` per source; the snapshot stays in target history until target compaction shadows or summarizes it.

### Canvas reference list

#### What the model sees

`canvas_reference_list` returns candidate session ids and labels the agent may choose to reference.

#### Token effect

One tool result with the candidate list; no persistent context added.

## Known Limitations and Deferred Work

- **Requires the session-reference resolver composed.** Without `ctx.sessionReferenceResolver` the tools fail loudly with a descriptive error rather than silently doing nothing.
- **No canvas-tree coupling yet.** The tools operate on raw session ids; a future canvas-aware variant could accept node references (turn + session) and prepare only that node's interval.
