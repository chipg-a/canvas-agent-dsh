/**
 * ConversationFlow: the native conversation message flow as an embeddable
 * component. The canvas right rail renders it so the rail IS the conversation
 * — same Node rendering, same scrollport rhythm as the chat view, without the
 * chat view's page-level chrome.
 *
 * The flow reads the current session's chat snapshot through the standard
 * useSession seat and dispatches each ordered Node through the narrowed
 * `renderChatNode` binding (declared by the resident 'conversation' entry —
 * one declarer, two render sites: the chat tab and the canvas rail).
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ConversationSnapshot, SessionId } from '@deepseek-ai/dsh-api-session-controller/client'
import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps, TurnTailOwnerProps } from '../contract/slots.ts'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import css from './ConversationFlow.module.css'

/** Owner callbacks the host view supplies (all optional; no-op defaults). */
export interface ConversationFlowCallbacks {
  /** Open a produced file through the host's workspace opener. */
  openFile?: (path: string) => void
  /** Resolve a session-authorized historical image for inline display. */
  loadImage?: (attachment: ImageAttachmentRef) => Promise<string>
  /** Hand a tool call to another view's inspect target (no-op on the canvas). */
  inspectCall?: (callId: string) => void
  /** Optional prose file-mention vocabulary. */
  fileMentions?: (owner: TurnTailOwnerProps) => MarkdownFileMentions | undefined
}

/** Full component props: session kit + narrowed node binding + callbacks + locale. */
export type ConversationFlowProps = ConversationFlowCallbacks & {
  readonly sessionId: SessionId
  readonly useSession: ChatViewSlotProps['useSession']
  readonly useSessions: ChatViewSlotProps['useSessions']
  readonly renderChatNode: (key: string, owner: object, opts?: {
    entryKey?: string
    hookContext?: unknown
    fallback?: React.ReactNode
  }) => React.ReactNode
  /**
   * The canvas-selected node's fork session: when set, the flow renders THAT
   * session's conversation in the rail (the node's own conversation, like the
   * native "在新对话中分支"), without switching the global session.
   */
  targetSessionId?: SessionId | null
  /** Live snapshot source for an arbitrary target session (absent until live). */
  sessionSnapshotOf?: (id: SessionId) => {
    getSnapshot: () => ConversationSnapshot | undefined
    subscribe: (fn: () => void) => () => void
  } | undefined
} & PropsLocale<'conversation'>

/**
 * Render the native conversation flow. Defaults to the current session; a
 * `targetSessionId` renders that session's conversation instead.
 * @param props - session kit, the narrowed node render binding, callbacks,
 * and the locale seat.
 * @returns the message flow scrollport.
 */
export function ConversationFlow({
  useSession, useSessions, sessionId, renderChatNode, t,
  openFile, loadImage, inspectCall, fileMentions,
  targetSessionId, sessionSnapshotOf,
}: ConversationFlowProps): React.JSX.Element {
  // A target session other than the current one: subscribe to ITS snapshot.
  // The source is memoized so its getSnapshot/subscribe identities stay
  // stable across renders (uSES contract; avoids subscribe churn).
  const target = targetSessionId !== undefined && targetSessionId !== null && targetSessionId !== sessionId
    ? targetSessionId
    : undefined
  // The current session's snapshot is ALWAYS read (unconditional hook): the
  // rail falls back to it while a target session is not instantiated yet, and
  // a later target arrival must not change the hook order.
  const currentSnapshot = useSession(s => s)
  const targetSource = useMemo(
    () => (target === undefined ? undefined : sessionSnapshotOf?.(target)),
    [target, sessionSnapshotOf],
  )
  const targetSnapshot = useSyncExternalStore(
    targetSource?.subscribe ?? (() => () => {}),
    targetSource?.getSnapshot ?? (() => undefined),
  )
  // Never undefined: the target snapshot when one is live, else the current
  // session's — keeps the flow renderable while the target session is not
  // instantiated yet (or is the current session).
  const active = targetSnapshot ?? currentSnapshot
  const order = active.chat.order ?? []
  const cwd = target === undefined
    ? useSessions(s => s.byId[sessionId]?.cwd)
    : useSessions(s => s.byId[target]?.cwd)
  const running = active.running
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // The session selector the node seats read: the target snapshot when one is
  // live, else the current session's — never called with undefined.
  const seatUseSession: ChatViewSlotProps['useSession'] = targetSnapshot === undefined
    ? useSession
    : (selector) => selector(targetSnapshot)

  // Follow the flow tail: new content (own words, streaming, tools) pins the
  // reader to the bottom, like the chat view's default open posture.
  useEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    el.scrollTop = el.scrollHeight
  }, [order.length, running])

  return (
    <div className={css.flowRoot} data-conversation-flow="">
      <div ref={scrollRef} className={css.flowScroll} data-conversation-flow-scroll="">
        <div className={css.flowColumn}>
          {order.length === 0 && (
            <div className={css.flowHint}>在此输入开始对话——消息会同步成为画布节点；点选画布节点，输入将针对该节点继续或分支。</div>
          )}
          {renderChatNode !== undefined && order.map(nodeKey => (
            <ChatNodeSeat
              key={nodeKey}
              nodeKey={nodeKey}
              useSession={seatUseSession}
              selectedCallId={undefined}
              cwd={cwd}
              openFile={openFile ?? (() => {})}
              inspectCall={inspectCall ?? (() => {})}
              loadImage={loadImage ?? (() => Promise.resolve(''))}
              fileMentions={fileMentions ?? (() => undefined)}
              renderSlot={renderChatNode}
              t={t}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
