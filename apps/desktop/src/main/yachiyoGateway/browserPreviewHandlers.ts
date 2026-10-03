import type {
  ControlBrowserAutomationSessionInput,
  OpenBrowserPreviewInput,
  ReleaseBrowserPreviewInput
} from '@yachiyo/shared/protocol'
import type { BrowserAutomationService } from '@yachiyo/runtime/services/browserAutomation/electronBrowserAutomationService'
import { handleYachiyoIpc } from './ipc'
import { IPC_CHANNELS } from './ipcChannels'
import { openBrowserPreview } from './openBrowserPreview'

export function registerBrowserPreviewHandlers(backend: () => BrowserAutomationService): void {
  handleYachiyoIpc(
    IPC_CHANNELS.controlBrowserAutomationSession,
    (input: ControlBrowserAutomationSessionInput) => {
      if (
        !input?.threadId?.trim() ||
        !input.session?.trim() ||
        ![
          'takeOver',
          'resume',
          'back',
          'forward',
          'reload',
          'navigate',
          'close',
          'annotate',
          'acceptDialog',
          'dismissDialog'
        ].includes(input.action) ||
        (input.action === 'navigate' && !input.url?.trim())
      )
        throw new Error('Invalid browser session control request.')
      return backend().controlSession(input)
    }
  )
  handleYachiyoIpc(IPC_CHANNELS.openBrowserPreview, (input: OpenBrowserPreviewInput) =>
    openBrowserPreview(backend(), input)
  )
  handleYachiyoIpc(IPC_CHANNELS.releaseBrowserPreview, (input: ReleaseBrowserPreviewInput) => {
    if (
      !input.threadId?.trim() ||
      !input.session?.trim() ||
      !['auto', 'close'].includes(input.mode)
    )
      throw new Error('Invalid browser preview release request.')
    return backend().releasePreview(input)
  })
}
