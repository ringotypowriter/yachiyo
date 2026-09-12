import React from 'react'
import { createRoot } from 'react-dom/client'
import { buildLayoutPreviewState } from './layoutFixture'
import '../src/assets/main.css'
import './layout-study.css'

const host = document.getElementById('root')!

// Never connect this study to a desktop session or a provider.
if (window.api?.yachiyo) {
  host.textContent = 'Open this layout study in a standalone browser.'
} else {
  window.api = {
    process: { platform: 'darwin' },
    yachiyo: {
      listBrowserAutomationSessions: async () => [],
      listBackgroundTasks: async () => [],
      subscribe: () => () => {},
      requestRecap: async () => '',
      answerToolQuestion: async () => {
        window.dispatchEvent(new Event('layout-preview-answer'))
      }
    }
  } as unknown as Window['api']

  void Promise.all([
    import('./ConversationLayoutPreview'),
    import('../src/app/store/useAppStore')
  ]).then(([{ ConversationLayoutPreview }, { useAppStore, DEFAULT_SETTINGS }]) => {
    useAppStore.setState(
      {
        ...useAppStore.getInitialState(),
        ...buildLayoutPreviewState('idle', false, new Date().toISOString()),
        connectionStatus: 'connected',
        settings: { ...DEFAULT_SETTINGS, apiKey: 'preview-only', model: 'Preview' },
        sendMessage: async () => false
      },
      true
    )
    createRoot(host).render(React.createElement(ConversationLayoutPreview))
  })
}
