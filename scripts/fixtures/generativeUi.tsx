import React, { useState } from 'react'
import '../../apps/desktop/src/renderer/src/assets/main.css'
import { createRoot } from 'react-dom/client'
import type { ToolCallRecord } from '@yachiyo/shared/protocol'
import { GenerativeUiCard } from '../../apps/desktop/src/renderer/src/features/chat/components/GenerativeUiCard'
import { useAppStore } from '../../apps/desktop/src/renderer/src/app/store/useAppStore'
import { AssistantMessageBubble } from '../../apps/desktop/src/renderer/src/features/chat/components/AssistantMessageBubble'
import { DEFAULT_THEME_ID, theme } from '../../apps/desktop/src/renderer/src/theme/theme'

const opened: string[] = []
window.open = (url): Window | null => {
  opened.push(String(url))
  return null
}
document.documentElement.dataset.yachiyoThemeVariant = 'light'
document.documentElement.dataset.yachiyoTheme = DEFAULT_THEME_ID

const source = {
  kind: 'renderUi' as const,
  title: 'Interactive counter',
  css: 'button{padding:8px 14px;border:0;border-radius:8px;background:coral;color:#111;margin:6px}#count{font-size:24px}html[data-theme="dark"]{color:#eee;background:#202020}',
  html: '<h2>Counter</h2><p id="count">0</p><button id="increment">Increment</button><canvas id="plot" width="160" height="40"></canvas><svg width="90" height="40"><circle cx="20" cy="20" r="14" fill="coral"/></svg><script>window.__htmlAttack=true</script><img src="x" onerror="window.__htmlAttack=true"><iframe src="https://example.com"></iframe><base href="https://example.com"><meta http-equiv="refresh" content="0;url=https://example.com"><button onclick="window.__htmlAttack=true">Static</button>',
  js: 'window.__executions=(window.__executions||0)+1;document.querySelector("#increment").addEventListener("click",()=>{document.querySelector("#count").textContent=String(Number(document.querySelector("#count").textContent)+1)});const ctx=document.querySelector("canvas").getContext("2d");ctx.fillStyle="coral";ctx.fillRect(0,0,80,20);'
}
const record: ToolCallRecord = {
  id: 'ui-smoke',
  threadId: 'smoke',
  toolName: 'renderUi',
  status: 'preparing',
  inputSummary: source.title,
  startedAt: '2026-10-05T10:00:00Z',
  details: source
}
useAppStore.setState({
  activeThreadId: 'smoke',
  composerDrafts: {
    smoke: {
      text: 'Existing draft',
      images: [],
      files: [
        {
          id: 'file',
          filename: 'notes.txt',
          mediaType: 'text/plain',
          dataUrl: 'data:text/plain;base64,YQ==',
          status: 'ready'
        }
      ]
    }
  }
})

function click(label: string): void {
  const buttons = Array.from(document.querySelectorAll('button'))
  const button = buttons.find(
    (element) =>
      element.getAttribute('aria-label') === label ||
      element.title === label ||
      element.textContent?.trim() === label
  )
  if (!button)
    throw new Error(
      `Missing button ${label}: ${buttons.map((item) => item.textContent || item.title).join(', ')}`
    )
  button.click()
}

function setFixtureTheme(theme: string): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  document.documentElement.dataset.yachiyoThemeVariant = theme
  document.documentElement.dataset.yachiyoThemeAppearance = theme
}

export function Fixture(): React.JSX.Element {
  const [toolCall, setToolCall] = useState(record)
  const [generation, setGeneration] = useState(0)
  Object.assign(window, {
    __uiSmoke: {
      preview: (): void =>
        setToolCall((value) => ({
          ...value,
          details: { ...source, html: source.html + '<p>Preview updated</p>' }
        })),
      complete: (): void =>
        setToolCall((value) => ({ ...value, status: 'completed', details: source })),
      theme: setFixtureTheme,
      pendingReady: (): boolean => document.body.textContent?.includes('Add to message') === true,
      draft: (): string => useAppStore.getState().composerDrafts.smoke.text,
      attachmentCount: (): number => useAppStore.getState().composerDrafts.smoke.files.length,
      openedLinks: (): string[] => [...opened],
      confirmDraft: (): void => click('Add to message'),
      confirmLink: (): void => click('Open link'),
      source: (): void => click('Source'),
      sourceReady: (): boolean => Boolean(document.querySelector('pre')),
      reset: (): void => click('Reset preview'),
      expand: (): void => click('Expand preview'),
      closeExpand: (): void => click('Close preview'),
      restore: (): void => {
        setToolCall(JSON.parse(JSON.stringify({ ...record, status: 'completed' })))
        setGeneration((value) => value + 1)
      },
      fail: (): void => {
        setToolCall({ ...record, status: 'failed', error: 'Generation stopped.' })
        setGeneration((value) => value + 1)
      },
      clean: (): void => {
        setToolCall({
          ...record,
          status: 'completed',
          details: { ...source, html: source.html.slice(0, source.html.indexOf('<script>')) }
        })
        setGeneration((value) => value + 1)
      }
    }
  })
  return (
    <main
      className="mx-auto h-full max-w-[760px] overflow-y-auto py-8"
      style={{ background: theme.background.canvas }}
    >
      <AssistantMessageBubble
        message={{
          id: 'intro',
          threadId: 'smoke',
          role: 'assistant',
          status: 'completed',
          createdAt: record.startedAt,
          content:
            'Try the counter below. The chart is drawn locally, and the controls stay inside this conversation.'
        }}
      />
      <GenerativeUiCard key={generation} toolCall={toolCall} />
      <AssistantMessageBubble
        message={{
          id: 'following',
          threadId: 'smoke',
          role: 'assistant',
          status: 'completed',
          createdAt: record.startedAt,
          content:
            'Use the toolbar to expand the preview, inspect its source, or reset the interaction.'
        }}
      />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
