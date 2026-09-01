/** Strict per-session header/body content inserted into the resident conversation layout. */

import { useEffect, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import type { SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  ConversationSessionHeaderSlotProps, ConversationSessionSlotProps, InputZone,
} from '../contract/slots.ts'
import type { ViewTab } from '../contract/views.ts'
import { ConversationFlow } from '../chat/ConversationFlow.tsx'
import css from './ConversationRoot.module.css'

/** Full props composed from the strict session body contract. */
export type ConversationSessionProps = ConversationSessionSlotProps

/** Full props composed from the strict session header contract. */
export type ConversationSessionHeaderProps = ConversationSessionHeaderSlotProps

interface Breadcrumb {
  readonly id: SessionId
  readonly displayTitle: string
}

/**
 * Resolve the active view: the persisted selection when it still exists,
 * else the ring's first tab. The old hard-coded Chat fallback is gone
 * because canvas-first deployments disable the chat tab entirely; the first
 * registered view (the canvas) becomes the default surface.
 */
function resolveActiveView(tabs: readonly ViewTab[], selectedId: string | null): ViewTab | undefined {
  const first = tabs[0]
  if (first === undefined) return undefined
  const requestedId = selectedId ?? first.id
  return tabs.find(view => view.id === requestedId) ?? first
}

function deriveAncestry(list: SessionListState, id: SessionId): readonly Breadcrumb[] {
  const chain: Breadcrumb[] = []
  const seen = new Set<SessionId>()
  let cursor: SessionId | undefined = id
  while (cursor !== undefined) {
    if (seen.has(cursor)) break
    seen.add(cursor)
    const summary: SessionSummary | undefined = list.byId[cursor]
    if (summary === undefined) break
    chain.unshift({ id: summary.id, displayTitle: summary.displayTitle })
    if (summary.origin !== 'subagent') break
    cursor = summary.parentId
  }
  return chain
}

function equalBreadcrumbs(left: readonly Breadcrumb[], right: readonly Breadcrumb[]): boolean {
  return left.length === right.length
    && left.every((item, index) => {
      const other = right.at(index)
      return other !== undefined && item.id === other.id && item.displayTitle === other.displayTitle
    })
}

/**
 * Renders Session header chrome above the resident conversation scrollport.
 * @param props - Strict Session store, view ledger, navigation, render, and locale shares.
 * @returns the hidden blank-session header or visible title and tabs.
 */
export function ConversationSessionHeader({
  sessionId, useSession, useSessions, useStore, actions,
  renderSlot, views, open, t,
}: ConversationSessionHeaderProps) {
  useSyncExternalStore(views.subscribe, views.version)
  const tabs = views.list()
  const selectedId = useStore(s => s.view)
  const active = resolveActiveView(tabs, selectedId)
  const ancestry = useSessions(s => deriveAncestry(s, sessionId), equalBreadcrumbs)
  const composerPhase = useSession(s => s.composerPhase)
  const blank = useSession(s => s.blank)
  const hideChrome = blank && composerPhase === 'blank'

  return (
    <header
      className={clsx(css.header, hideChrome && css.headerHidden)}
      aria-hidden={hideChrome || undefined}
    >
      {!hideChrome && (
        <>
          <div className={css.titleRow}>
            <div className={css.titleCluster}>
              <nav className={css.crumbs} aria-label={t('session.hierarchy')}>
                {ancestry.map((summary, index) => {
                  const last = index === ancestry.length - 1
                  return (
                    <span key={summary.id} className={css.crumbSeg}>
                      {index > 0 && <span className={css.crumbSep}>/</span>}
                      <button
                        type="button"
                        className={clsx(css.crumb, last && css.crumbCurrent)}
                        disabled={last}
                        onClick={() => { open(summary.id) }}
                      >
                        {summary.displayTitle}
                      </button>
                    </span>
                  )
                })}
                {ancestry.length === 0 && <span className={css.crumbCurrent}>{sessionId}</span>}
              </nav>
              <div className={css.headerActions}>
                {renderSlot('conversation.session.header.actions', {})}
              </div>
            </div>
            <div className={css.headerUtilities}>
              {renderSlot('conversation.session.header.utilities', {})}
            </div>
          </div>
          {tabs.length > 1 && (
            <div className={css.tabs} role="tablist">
              {tabs.map(viewTab => (
                <button
                  key={viewTab.id}
                  type="button"
                  role="tab"
                  aria-selected={viewTab.id === active?.id}
                  className={clsx(css.tab, viewTab.id === active?.id && css.tabActive)}
                  onClick={() => { actions.setView(viewTab.id) }}
                >
                  {viewTab.label}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </header>
  )
}

/**
 * Renders the active Session view inside the resident scrollport and keeps
 * the input draft mirrored while blank Hero chrome is visible.
 * @param props - Strict Session input/store, view ledger, and render shares.
 * @returns the active view area, or null while the Session remains blank.
 */
export function ConversationSession({
  sessionId, useSession, useSessions, useInput, inputActions, useStore, actions,
  renderSlot, views, bindDraftMirror, releaseSessionImages, loadImage, railTarget, sessionSnapshotOf,
  renderPlan, renderModel, renderOverlay, renderDock, renderStats, renderLeft, renderRight,
  renderChatNode, t,
}: ConversationSessionProps) {
  useSyncExternalStore(views.subscribe, views.version)
  // The rail flow follows the canvas-selected node's fork session (null = current).
  const railSessionId = useSyncExternalStore(railTarget.subscribe, railTarget.getSnapshot)
  const tabs = views.list()
  const selectedId = useStore(s => s.view)
  const active = resolveActiveView(tabs, selectedId)
  const composerPhase = useSession(s => s.composerPhase)
  const blank = useSession(s => s.blank)
  const sessionSnapshot = useSession(s => s)
  const inputState = useInput(s => s)
  // The input-region currency (same shape the resident entry passes its
  // bindings): session + input snapshots for the dock/stats/tool-row seats.
  const zone: InputZone | undefined =
    inputState === undefined ? undefined : { session: sessionSnapshot, input: inputState }
  const storedDraft = useStore(s => s.draft)
  // `?? null`: persisted snapshots from before the inspect field rehydrate without it.
  const inspect = useStore(s => s.inspect ?? null)

  useEffect(() => {
    if (inputState.draft === '' && storedDraft !== '') inputActions.setDraft(storedDraft)
    const unmirror = bindDraftMirror(actions.setDraft)
    return () => { unmirror() }
    // Mount-only (deps pinned to inputActions): later store writes come from
    // the machine mirror, not this seed effect.
  }, [inputActions])

  useEffect(() => () => {
    releaseSessionImages(sessionId)
  }, [releaseSessionImages, sessionId])

  if (blank && composerPhase === 'blank') return null
  // The active view may host the native composer in its own layout (the
  // canvas right rail): render the rail composer once here — the view
  // skeleton declares no composer of its own — and pass the result through
  // the view's owner props. The root seat still renders (hero and non-owner
  // views keep it); the view only receives it when it opts in. The rail
  // carries the full native chrome: the region bindings from the resident
  // entry render the dock strips above the card and the overlay/stats/tool
  // seats inside it, so the canvas composer loses nothing the bar shows.
  const composerBar = active?.hostsComposer === true
    ? (
      <div className={css.railComposerStack}>
        {zone !== undefined && renderDock?.(zone)}
        {renderSlot('conversation.composer.rail', {
          variant: 'composer',
          overlay: renderOverlay?.(),
          ...(zone === undefined
            ? {}
            : {
              leftItems: renderLeft?.(zone),
              rightItems: renderRight?.(zone),
              footer: renderStats?.(zone),
            }),
          ...(renderPlan === undefined ? {} : { renderPlan }),
          ...(renderModel === undefined ? {} : { renderModel }),
        })}
      </div>
    )
    : undefined
  // The embeddable native conversation flow for views that host the
  // conversation in their own layout (the canvas right rail): the session
  // body renders it once (the same Node rendering the chat view uses) and
  // hands the result through the view owner props.
  const conversationFlow = active?.hostsComposer === true && renderChatNode !== undefined
    ? (
      <ConversationFlow
        sessionId={sessionId}
        useSession={useSession}
        useSessions={useSessions}
        renderChatNode={renderChatNode}
        loadImage={loadImage}
        targetSessionId={railSessionId}
        sessionSnapshotOf={sessionSnapshotOf}
        t={t}
      />
    )
    : undefined
  return (
    <div
      className={css.viewArea}
      data-hide-composer={active?.hideComposer === true || undefined}
      data-lock-view={active?.hostsComposer === true || undefined}
    >
      {active !== undefined && renderSlot('conversation.view', {
        inspect,
        onInspectDone: () => { actions.setInspect(null) },
        ...(composerBar === undefined ? {} : { composerBar }),
        ...(renderChatNode === undefined ? {} : { renderChatNode }),
        ...(conversationFlow === undefined ? {} : { conversationFlow }),
      }, { only: active.id })}
    </div>
  )
}
