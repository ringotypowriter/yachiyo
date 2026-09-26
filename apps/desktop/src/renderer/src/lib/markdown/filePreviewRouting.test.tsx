import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { AppDialogContext } from '@renderer/components/AppDialogContext'
import { ContentReaderProvider } from '@renderer/features/chat/components/ContentReaderContext'
import { useContentReaderStore } from '@renderer/features/chat/state/useContentReaderStore'
import { LinkableCode } from './LinkableCode'
import { WorkspaceFileLink } from './WorkspaceFileLink'
import { WORKSPACE_FILE_REFERENCE_PROPERTY } from './workspaceFileLinkRehypePlugin'

// Exercise the rendered click handlers, not just the configured-app resolver.
test('configured app clicks stay external while explicit preview and unconfigured fallback stay internal', async () => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>')
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const opens: unknown[] = []
  Object.assign(window, {
    api: {
      yachiyo: {
        openFile: async (input: unknown) => {
          opens.push(input)
        }
      }
    }
  })
  const previousConfig = useAppStore.getState().config
  const root = createRoot(document.getElementById('root')!)
  const path = '/work/report.md'
  const links = new Map([['report.md', path]])
  const config = (markdownApp?: string): void =>
    useAppStore.setState({
      config: {
        ...previousConfig,
        workspace: { ...previousConfig?.workspace, markdownApp }
      } as NonNullable<typeof previousConfig>
    })
  try {
    config('Obsidian')
    useContentReaderStore.setState(useContentReaderStore.getInitialState(), true)
    await act(async () =>
      root.render(
        <AppDialogContext.Provider
          value={{ alert: async () => {}, confirm: async () => false, prompt: async () => null }}
        >
          <ContentReaderProvider threadId="a" workspacePath="/work">
            <LinkableCode fileLinks={links}>report.md</LinkableCode>
            <WorkspaceFileLink
              node={{ properties: { [WORKSPACE_FILE_REFERENCE_PROPERTY]: 'report.md' } }}
              fileLinks={links}
              workspaceScope={{ threadId: 'a', workspacePath: '/work' }}
            >
              Report
            </WorkspaceFileLink>
          </ContentReaderProvider>
        </AppDialogContext.Provider>
      )
    )
    await act(async () => {
      document.querySelector<HTMLElement>('code[role="link"]')!.click()
    })
    assert.deepEqual(opens[0], { path, appSelection: 'Obsidian', appKind: 'markdown' })
    assert.equal(useContentReaderStore.getState().target, null)
    await act(async () => {
      document.querySelector<HTMLElement>('span[role="link"]')!.click()
    })
    assert.deepEqual(opens[1], {
      path,
      threadId: 'a',
      workspacePath: '/work',
      workspaceOnly: true,
      appSelection: 'Obsidian',
      appKind: 'markdown'
    })
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="Preview in Yachiyo"]')!.click()
    })
    assert.equal(useContentReaderStore.getState().target?.kind, 'file')
    assert.equal(opens.length, 2)
    await act(async () => {
      useContentReaderStore.getState().select('a', 'chat')
      config(undefined)
    })
    await act(async () => {
      document.querySelector<HTMLElement>('code[role="link"]')!.click()
    })
    assert.equal(useContentReaderStore.getState().target?.kind, 'file')
    assert.equal(opens.length, 2)
  } finally {
    await act(async () => root.unmount())
    useAppStore.setState({ config: previousConfig })
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
