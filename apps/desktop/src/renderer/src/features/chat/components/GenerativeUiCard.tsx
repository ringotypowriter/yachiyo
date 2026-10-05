import type React from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Code2, ExternalLink, Maximize2, Minimize2, PanelsTopLeft, RotateCcw } from 'lucide-react'
import type { ToolCall } from '@renderer/app/types'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { EMPTY_COMPOSER_DRAFT, getComposerDraftKey } from '@renderer/app/store/useAppStore/helpers'
import { alpha, theme, themeRgbTokenVars } from '@renderer/theme/theme'
import type { RenderUiToolCallDetails } from '@yachiyo/shared/protocol'
import {
  appendConfirmedRenderUiText,
  parseRenderUiOutput,
  type RenderUiOutput
} from '../lib/render-ui/renderUiBoundary'

interface GenerativeUiCardProps {
  toolCall: ToolCall
  onContentSizeChange?: (descendant: HTMLElement) => void
}

function getDetails(toolCall: ToolCall): RenderUiToolCallDetails {
  const details = toolCall.details
  if (details && 'kind' in details && details.kind === 'renderUi') return details
  const raw = toolCall.rawInput
  if (raw && typeof raw === 'object') {
    const value = raw as Record<string, unknown>
    return {
      kind: 'renderUi',
      title: typeof value.title === 'string' ? value.title : '',
      html: typeof value.html === 'string' ? value.html : '',
      css: typeof value.css === 'string' ? value.css : '',
      js: typeof value.js === 'string' ? value.js : ''
    }
  }
  return { kind: 'renderUi', title: '', html: '', css: '', js: '' }
}

function sourceText(details: RenderUiToolCallDetails): string {
  return [
    details.html && `HTML\n${details.html}`,
    details.css && `CSS\n${details.css}`,
    details.js && `JavaScript\n${details.js}`
  ]
    .filter(Boolean)
    .join('\n\n')
}

function getPreviewThemeVars(): Record<string, string> {
  const computed = getComputedStyle(document.documentElement)
  const vars: Record<string, string> = {}
  for (const name of Object.values(themeRgbTokenVars)) {
    const value = computed.getPropertyValue(name).trim()
    if (value) vars[name] = value
  }
  const font = computed.getPropertyValue('--yachiyo-font-ui').trim()
  if (font) vars['--yachiyo-font-ui'] = font
  return vars
}

/** The iframe can only propose actions. A separate, explicit click in this card executes them. */
function GenerativeUiCardContent({
  toolCall,
  onContentSizeChange
}: GenerativeUiCardProps): React.JSX.Element {
  const details = useMemo(() => getDetails(toolCall), [toolCall])
  const completed = toolCall.status === 'completed'
  const native =
    typeof window !== 'undefined' &&
    Boolean(window.api?.process?.versions?.electron && window.api?.yachiyo)
  const [expanded, setExpanded] = useState(false)
  const [showSource, setShowSource] = useState(false)
  const [generation, setGeneration] = useState(0)
  const [height, setHeight] = useState(240)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<Extract<
    RenderUiOutput,
    { type: 'openLink' | 'continueConversation' }
  > | null>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const portRef = useRef<MessagePort | null>(null)
  const lastHeightAtRef = useRef(0)
  const lastActionAtRef = useRef(0)
  const burstRef = useRef({ start: 0, count: 0 })
  const latestRef = useRef({ details, completed })

  useLayoutEffect(() => {
    latestRef.current = { details, completed }
  }, [details, completed])

  useLayoutEffect(() => {
    if (!native) return
    const frame = frameRef.current
    if (!frame) return
    let connected = false
    let port: MessagePort | null = null
    const receiveReady = (event: MessageEvent): void => {
      if (connected || event.source !== frame.contentWindow) return
      if (!event.data || typeof event.data !== 'object' || event.data.type !== 'yachiyo-ui-ready')
        return
      connected = true
      const channel = new MessageChannel()
      const connectedPort = channel.port1
      port = connectedPort
      portRef.current = connectedPort
      connectedPort.onmessage = (message: MessageEvent): void => {
        if (portRef.current !== connectedPort) return
        const output = parseRenderUiOutput(message.data)
        if (!output) return
        const receivedAt = Date.now()
        if (receivedAt - burstRef.current.start >= 1000) {
          burstRef.current = { start: receivedAt, count: 0 }
        }
        if (burstRef.current.count >= 20) return
        burstRef.current.count += 1
        if (output.type === 'height') {
          const now = Date.now()
          if (now - lastHeightAtRef.current < 100) return
          lastHeightAtRef.current = now
          setHeight(output.height)
        } else if (output.type === 'error') {
          setError(output.message)
        } else {
          const now = Date.now()
          if (now - lastActionAtRef.current < 200) return
          lastActionAtRef.current = now
          setPending(output)
        }
      }
      connectedPort.start()
      frame.contentWindow?.postMessage({ type: 'yachiyo-ui-connect' }, '*', [channel.port2])
      const current = latestRef.current
      connectedPort.postMessage({
        type: 'render',
        ...current.details,
        completed: current.completed,
        theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
        themeVars: getPreviewThemeVars()
      })
    }
    window.addEventListener('message', receiveReady)
    return () => {
      window.removeEventListener('message', receiveReady)
      portRef.current = null
      if (port) {
        port.onmessage = null
        port.close()
      }
    }
  }, [native, completed, generation, toolCall.id])

  useEffect(() => {
    const port = portRef.current
    if (!port) return
    port.postMessage({
      type: 'render',
      ...details,
      completed,
      theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      themeVars: getPreviewThemeVars()
    })
  }, [details, completed])

  useEffect(() => {
    if (!native) return
    const observer = new MutationObserver(() => {
      portRef.current?.postMessage({
        type: 'render',
        ...latestRef.current.details,
        completed: latestRef.current.completed,
        theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
        themeVars: getPreviewThemeVars()
      })
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [
        'class',
        'style',
        'data-yachiyo-theme',
        'data-yachiyo-theme-variant',
        'data-yachiyo-theme-appearance'
      ]
    })
    return () => observer.disconnect()
  }, [native, completed, generation, toolCall.id])

  useEffect(() => {
    if (cardRef.current) onContentSizeChange?.(cardRef.current)
  }, [height, expanded, showSource, pending, error, onContentSizeChange])

  const toggleExpanded = (): void => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (expanded) {
      dialog.close()
      dialog.setAttribute('open', '')
      setExpanded(false)
    } else {
      dialog.close()
      dialog.showModal()
      setExpanded(true)
    }
  }

  const approve = (): void => {
    if (!pending) return
    if (pending.type === 'openLink') {
      // The main window's setWindowOpenHandler routes approved links to shell.openExternal.
      window.open(pending.url, '_blank', 'noreferrer')
    } else {
      const text = pending.text
      useAppStore.setState((state) => {
        const key = getComposerDraftKey(toolCall.threadId)
        return {
          composerDrafts: appendConfirmedRenderUiText(
            state.composerDrafts,
            key,
            text,
            EMPTY_COMPOSER_DRAFT
          )
        }
      })
    }
    setPending(null)
  }

  const buttonClass =
    'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border-0 bg-transparent transition-colors hover:bg-[rgb(var(--yachiyo-rgb-ink)/0.05)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[rgb(var(--yachiyo-rgb-accent))]'
  const buttonStyle = { color: theme.text.muted }
  return (
    <div ref={cardRef} className="px-6 py-1" data-generative-ui-card={toolCall.id}>
      <dialog
        ref={dialogRef}
        open
        aria-modal={expanded ? true : undefined}
        aria-label={details.title || 'Interactive preview'}
        onCancel={(event) => {
          event.preventDefault()
          toggleExpanded()
        }}
        className={
          expanded
            ? 'fixed inset-4 z-[210] flex h-[calc(100%-2rem)] w-[calc(100%-2rem)] max-w-none flex-col overflow-hidden p-0 backdrop:bg-black/40'
            : 'relative m-0 block w-full max-w-none overflow-hidden p-0'
        }
        style={{
          borderRadius: 14,
          border: `1px solid ${theme.border.default}`,
          background: theme.background.surface,
          boxShadow: theme.shadow.card,
          fontFamily: theme.font.ui
        }}
      >
        <div
          className="flex min-h-11 items-center gap-2 px-3"
          style={{ borderBottom: `1px solid ${theme.border.subtle}` }}
        >
          <PanelsTopLeft
            size={14}
            strokeWidth={1.8}
            className="shrink-0"
            style={{ color: theme.text.accent }}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <div
              className="truncate"
              style={{
                color: theme.text.primary,
                fontSize: 12.5,
                fontWeight: 650,
                letterSpacing: '-0.05px'
              }}
            >
              {details.title || 'Interactive preview'}
            </div>
            {!completed ? (
              <div
                role="status"
                style={{
                  color: toolCall.status === 'failed' ? theme.text.danger : theme.text.placeholder,
                  fontSize: 10.5,
                  lineHeight: '13px'
                }}
              >
                {toolCall.status === 'failed' ? 'Preview unavailable' : 'Generating preview'}
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              className={buttonClass}
              style={buttonStyle}
              aria-label={expanded ? 'Close preview' : 'Expand preview'}
              title={expanded ? 'Close preview' : 'Expand preview'}
              onClick={toggleExpanded}
            >
              {expanded ? (
                <Minimize2 size={15} strokeWidth={1.8} />
              ) : (
                <Maximize2 size={15} strokeWidth={1.8} />
              )}
            </button>
            <button
              type="button"
              className={buttonClass}
              style={
                showSource
                  ? {
                      ...buttonStyle,
                      background: theme.background.accentSoft,
                      color: theme.text.accent
                    }
                  : buttonStyle
              }
              aria-label="Source"
              title="Source"
              aria-expanded={showSource}
              onClick={() => setShowSource(!showSource)}
            >
              <Code2 size={15} strokeWidth={1.8} />
            </button>
            {native ? (
              <button
                type="button"
                className={buttonClass}
                style={buttonStyle}
                aria-label="Reset preview"
                title="Reset preview"
                onClick={() => {
                  setPending(null)
                  setError(null)
                  setHeight(240)
                  setGeneration((n) => n + 1)
                }}
              >
                <RotateCcw size={15} strokeWidth={1.8} />
              </button>
            ) : null}
          </div>
        </div>
        {native ? (
          <iframe
            key={`${toolCall.id}:${completed}:${generation}`}
            ref={frameRef}
            title={details.title || 'Interactive preview'}
            src="yachiyo-ui://sandbox/"
            sandbox="allow-scripts"
            className={expanded ? 'block min-h-0 w-full flex-1 border-0' : 'block w-full border-0'}
            style={{ ...(expanded ? {} : { height }), background: theme.background.canvas }}
          />
        ) : (
          <div className="px-3 py-4" style={{ color: theme.text.secondary, fontSize: 11 }}>
            <div>Interactive preview is available in the desktop app.</div>
            <pre
              className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words"
              style={{
                color: theme.text.muted,
                fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace"
              }}
            >
              {details.html}
            </pre>
          </div>
        )}
        {error ? (
          <div
            role="alert"
            className="px-3 py-2 text-[11px]"
            style={{ color: theme.text.danger, borderTop: `1px solid ${theme.border.subtle}` }}
          >
            {error}
          </div>
        ) : null}
        {pending ? (
          <div
            className="flex items-center gap-2 px-3 py-2 text-[11px]"
            style={{
              background: theme.background.accentSoft,
              borderTop: `1px solid ${theme.border.subtle}`,
              color: theme.text.secondary
            }}
          >
            <span className="min-w-0 flex-1 break-all">
              {pending.type === 'openLink'
                ? `Open external link: ${pending.url}`
                : `Add to message: ${pending.text}`}
            </span>
            <button
              type="button"
              className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 font-medium hover:opacity-75 focus-visible:outline-2"
              style={{
                color: theme.text.accent,
                background: alpha('accent', 0.08),
                border: `1px solid ${alpha('accent', 0.18)}`
              }}
              onClick={approve}
            >
              {pending.type === 'openLink' ? <ExternalLink size={12} strokeWidth={1.8} /> : null}
              {pending.type === 'openLink' ? 'Open link' : 'Add to message'}
            </button>
            <button
              type="button"
              className="shrink-0 rounded px-1.5 py-1 hover:opacity-70"
              style={{ color: theme.text.muted, background: 'transparent', border: 0 }}
              onClick={() => setPending(null)}
            >
              Dismiss
            </button>
          </div>
        ) : null}
        {showSource ? (
          <div className="p-3" style={{ borderTop: `1px solid ${theme.border.subtle}` }}>
            <pre
              data-render-ui-source
              className="message-selectable m-0 max-h-80 overflow-auto rounded-md px-3 py-2 text-[10.5px] leading-[1.5] whitespace-pre-wrap break-words"
              style={{
                background: theme.background.codeBlock,
                border: `1px solid ${theme.border.default}`,
                color: theme.text.secondary,
                fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace"
              }}
            >
              {sourceText(details)}
            </pre>
          </div>
        ) : null}
      </dialog>
    </div>
  )
}

export function GenerativeUiCard(props: GenerativeUiCardProps): React.JSX.Element {
  return (
    <GenerativeUiCardContent key={`${props.toolCall.threadId}:${props.toolCall.id}`} {...props} />
  )
}
