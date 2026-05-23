import { tool, type Tool } from 'ai'

import type { UseBrowserToolCallDetails } from '../../../../shared/yachiyo/protocol.ts'
import type {
  BrowserAutomationService,
  BrowserAutomationSnapshot
} from '../../services/browserAutomation/electronBrowserAutomationService.ts'

import {
  textContent,
  toToolModelOutput,
  useBrowserToolInputSchema,
  type AgentToolContext,
  type UseBrowserToolInput,
  type UseBrowserToolOutput
} from './shared.ts'

const DEFAULT_WAIT_PREDICATE = `(() => document.readyState === 'complete')()`

function isMissingSessionError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('No browser session')
}

function formatRefs(snapshot: BrowserAutomationSnapshot, limit = 30): string {
  if (snapshot.refs.length === 0) return ''
  const shown = snapshot.refs.slice(0, limit)
  const lines = shown.map((ref) => {
    const bits: string[] = []
    if (ref.text) bits.push(ref.text)
    if (ref.ariaLabel) bits.push(`aria="${ref.ariaLabel}"`)
    if (ref.placeholder) bits.push(`placeholder="${ref.placeholder}"`)
    if (ref.id) bits.push(`id="${ref.id}"`)
    if (ref.role) bits.push(`role="${ref.role}"`)
    if (ref.name) bits.push(`name="${ref.name}"`)
    if (ref.testId) bits.push(`data-testid="${ref.testId}"`)
    if (ref.selectorHint) bits.push(`selector="${ref.selectorHint}"`)
    if (ref.href) bits.push(ref.href)
    const label = bits.length > 0 ? ` — ${bits.join(' | ')}` : ''
    return `@${ref.ref} <${ref.tag}>${label}`
  })
  const omitted =
    snapshot.refs.length > shown.length ? `\n… +${snapshot.refs.length - shown.length} more` : ''
  return `${lines.join('\n')}${omitted}`
}

function formatPageText(snapshot: BrowserAutomationSnapshot): string {
  const sections: string[] = []
  if (snapshot.pageText.headings.length > 0) {
    sections.push(`Headings:\n${snapshot.pageText.headings.map((line) => `- ${line}`).join('\n')}`)
  }
  if (snapshot.pageText.snippets.length > 0) {
    sections.push(`Snippets:\n${snapshot.pageText.snippets.map((line) => `- ${line}`).join('\n')}`)
  }
  if (snapshot.pageText.viewport) {
    sections.push(`Viewport text:\n${snapshot.pageText.viewport}`)
  }
  return sections.length > 0 ? `Page text\n${sections.join('\n\n')}` : ''
}

export function createTool(
  context: AgentToolContext,
  deps: { browserAutomationService?: BrowserAutomationService } = {}
): Tool<UseBrowserToolInput, UseBrowserToolOutput> {
  return tool({
    description:
      'Browser automation for opening pages, inspecting content, clicking, filling forms, scrolling, and capturing screenshots or PDFs. The browser window is visible to the user and they can interact with it directly. If a step requires human action (e.g. CAPTCHA, login, 2FA, consent dialog), ask the user to perform it rather than failing. Sessions are scoped to this conversation, but cookies and storage are shared globally. Start with action="open"; loadUrl, snapshot, and wait auto-open the session if needed.',
    inputSchema: useBrowserToolInputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: async (input) => {
      const service = deps.browserAutomationService
      if (!service) {
        return {
          content: textContent('Browser automation is not available in this environment.'),
          details: {
            kind: 'useBrowser',
            action: input.action,
            session: input.session
          } satisfies UseBrowserToolCallDetails,
          metadata: {},
          error: 'Browser automation service unavailable.'
        }
      }

      const threadId = context.threadId
      if (!threadId) {
        return {
          content: textContent('Browser automation is not available in this context.'),
          details: {
            kind: 'useBrowser',
            action: input.action,
            session: input.session
          } satisfies UseBrowserToolCallDetails,
          metadata: {},
          error: 'Missing threadId for browser session scoping.'
        }
      }

      const session = input.session
      const value = input.value ?? input.text
      const baseDetails: UseBrowserToolCallDetails = {
        kind: 'useBrowser',
        action: input.action,
        session,
        ...(input.url ? { url: input.url } : {}),
        ...(input.ref ? { ref: input.ref } : {}),
        ...(input.key ? { key: input.key } : {}),
        ...(input.direction ? { direction: input.direction } : {}),
        ...(input.amount ? { amount: input.amount } : {}),
        ...(value !== undefined ? { value } : {}),
        ...(input.checked !== undefined ? { checked: input.checked } : {}),
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {})
      }

      try {
        switch (input.action) {
          case 'open': {
            const opened = await service.open({
              threadId,
              session,
              ...(input.url ? { url: input.url } : {}),
              ...(input.viewport ? { viewport: input.viewport } : {})
            })
            const finalUrl = opened.url
            const title = opened.title
            return {
              content: textContent(title ? `Opened: ${title}\n${finalUrl}` : `Opened: ${finalUrl}`),
              details: {
                ...baseDetails,
                finalUrl,
                ...(title ? { title } : {})
              },
              metadata: {}
            }
          }
          case 'close': {
            await service.close({ threadId, session })
            return {
              content: textContent(`Closed browser session: ${session}`),
              details: baseDetails,
              metadata: {}
            }
          }
          case 'getUrl': {
            const finalUrl = await service.getUrl({ threadId, session })
            return {
              content: textContent(finalUrl),
              details: { ...baseDetails, finalUrl },
              metadata: {}
            }
          }
          case 'getTitle': {
            const title = await service.getTitle({ threadId, session })
            return {
              content: textContent(title),
              details: { ...baseDetails, title },
              metadata: {}
            }
          }
          case 'loadUrl': {
            if (!input.url) throw new Error('url is required for loadUrl')
            const finalUrl = await service
              .loadUrl({ threadId, session, url: input.url })
              .catch(async (error: unknown) => {
                if (!isMissingSessionError(error)) throw error
                await service.open({ threadId, session })
                return service.loadUrl({ threadId, session, url: input.url! })
              })
            return {
              content: textContent(`Loaded: ${finalUrl}`),
              details: { ...baseDetails, finalUrl },
              metadata: {}
            }
          }
          case 'wait': {
            const predicate = input.predicate ?? DEFAULT_WAIT_PREDICATE
            await service
              .waitForFunction({
                threadId,
                session,
                predicate,
                timeoutMs: input.timeoutMs
              })
              .catch(async (error: unknown) => {
                if (!isMissingSessionError(error) || !input.url) throw error
                await service.open({ threadId, session, url: input.url })
                return service.waitForFunction({
                  threadId,
                  session,
                  predicate,
                  timeoutMs: input.timeoutMs
                })
              })
            const finalUrl = await service.getUrl({ threadId, session })
            return {
              content: textContent(`Ready: ${finalUrl}`),
              details: { ...baseDetails, finalUrl },
              metadata: {}
            }
          }
          case 'snapshot': {
            const snapshot = await service
              .snapshot({
                threadId,
                session,
                maxRefs: input.maxRefs
              })
              .catch(async (error: unknown) => {
                if (!isMissingSessionError(error) || !input.url) throw error
                await service.open({ threadId, session, url: input.url })
                return service.snapshot({ threadId, session, maxRefs: input.maxRefs })
              })
            const refsText = formatRefs(snapshot)
            const pageText = formatPageText(snapshot)
            const header = snapshot.title ? `${snapshot.title}\n${snapshot.url}` : snapshot.url
            const body = [header, pageText, refsText].filter(Boolean).join('\n\n')
            return {
              content: textContent(body),
              details: {
                ...baseDetails,
                finalUrl: snapshot.url,
                ...(snapshot.title ? { title: snapshot.title } : {}),
                refCount: snapshot.refCount
              },
              metadata: {}
            }
          }
          case 'scroll': {
            const result = await service.scroll({
              threadId,
              session,
              ...(input.direction ? { direction: input.direction } : {}),
              ...(input.amount ? { amount: input.amount } : {}),
              ...(input.ref ? { ref: input.ref } : {})
            })
            return {
              content: textContent(`Scrolled: ${result.url}`),
              details: {
                ...baseDetails,
                finalUrl: result.url,
                ...(result.title ? { title: result.title } : {})
              },
              metadata: {}
            }
          }
          case 'goBack': {
            const result = await service.goBack({ threadId, session })
            return {
              content: textContent(`Went back: ${result.url}`),
              details: {
                ...baseDetails,
                finalUrl: result.url,
                ...(result.title ? { title: result.title } : {})
              },
              metadata: {}
            }
          }
          case 'goForward': {
            const result = await service.goForward({ threadId, session })
            return {
              content: textContent(`Went forward: ${result.url}`),
              details: {
                ...baseDetails,
                finalUrl: result.url,
                ...(result.title ? { title: result.title } : {})
              },
              metadata: {}
            }
          }
          case 'click': {
            if (!input.ref) throw new Error('ref is required for click')
            const result = await service.click({ threadId, session, ref: input.ref })
            return {
              content: textContent(`Clicked @${input.ref}: ${result.url}`),
              details: {
                ...baseDetails,
                finalUrl: result.url,
                ...(result.title ? { title: result.title } : {})
              },
              metadata: {}
            }
          }
          case 'fill': {
            if (!input.ref) throw new Error('ref is required for fill')
            const result = await service.fill({
              threadId,
              session,
              ref: input.ref,
              text: input.text ?? ''
            })
            return {
              content: textContent(`Filled @${input.ref}: ${result.url}`),
              details: {
                ...baseDetails,
                finalUrl: result.url,
                ...(result.title ? { title: result.title } : {})
              },
              metadata: {}
            }
          }
          case 'type': {
            if (!input.ref) throw new Error('ref is required for type')
            const result = await service.type({
              threadId,
              session,
              ref: input.ref,
              text: input.text ?? ''
            })
            return {
              content: textContent(`Typed into @${input.ref}: ${result.url}`),
              details: {
                ...baseDetails,
                finalUrl: result.url,
                ...(result.title ? { title: result.title } : {})
              },
              metadata: {}
            }
          }
          case 'select': {
            if (!input.ref) throw new Error('ref is required for select')
            const value = input.value ?? input.text
            if (value === undefined) throw new Error('value is required for select')
            const result = await service.select({ threadId, session, ref: input.ref, value })
            return {
              content: textContent(`Selected @${input.ref}: ${result.url}`),
              details: {
                ...baseDetails,
                finalUrl: result.url,
                ...(result.title ? { title: result.title } : {})
              },
              metadata: {}
            }
          }
          case 'check': {
            if (!input.ref) throw new Error('ref is required for check')
            if (input.checked === undefined) throw new Error('checked is required for check')
            const result = await service.check({
              threadId,
              session,
              ref: input.ref,
              checked: input.checked
            })
            return {
              content: textContent(
                `${input.checked ? 'Checked' : 'Unchecked'} @${input.ref}: ${result.url}`
              ),
              details: {
                ...baseDetails,
                finalUrl: result.url,
                ...(result.title ? { title: result.title } : {})
              },
              metadata: {}
            }
          }
          case 'press': {
            if (!input.key) throw new Error('key is required for press')
            const result = await service.press({ threadId, session, key: input.key })
            return {
              content: textContent(`Pressed: ${input.key}: ${result.url}`),
              details: {
                ...baseDetails,
                finalUrl: result.url,
                ...(result.title ? { title: result.title } : {})
              },
              metadata: {}
            }
          }
          case 'screenshot': {
            const result = await service.screenshot({
              threadId,
              session,
              workspacePath: context.workspacePath,
              ...(input.fileName ? { fileName: input.fileName } : {})
            })
            return {
              content: textContent(`Saved screenshot: ${result.savedFileName}`),
              details: {
                ...baseDetails,
                savedFileName: result.savedFileName,
                savedFilePath: result.savedFilePath,
                bytesWritten: result.bytesWritten
              },
              metadata: {}
            }
          }
          case 'pdf': {
            const result = await service.pdf({
              threadId,
              session,
              workspacePath: context.workspacePath,
              ...(input.fileName ? { fileName: input.fileName } : {})
            })
            return {
              content: textContent(`Saved PDF: ${result.savedFileName}`),
              details: {
                ...baseDetails,
                savedFileName: result.savedFileName,
                savedFilePath: result.savedFilePath,
                bytesWritten: result.bytesWritten
              },
              metadata: {}
            }
          }
          default: {
            const exhaustive: never = input.action
            throw new Error(`Unsupported action: ${exhaustive}`)
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: textContent(message),
          details: baseDetails,
          metadata: {},
          error: message
        }
      }
    }
  })
}
