import { z } from 'zod'

import { hexIdSchema, isoDateTimeSchema, remoteEndpointListSchema } from './common.ts'

/** Decrypted content of `iCloud Drive/Documents/Yachiyo/Remote/<mailboxId>.box`. */
export const mailboxPlaintextSchema = z
  .object({
    remoteDeviceId: hexIdSchema,
    endpoints: remoteEndpointListSchema,
    counter: z.int().min(1),
    issuedAt: isoDateTimeSchema
  })
  .meta({ id: 'RemoteMailboxPlaintext' })

export type MailboxPlaintext = z.infer<typeof mailboxPlaintextSchema>
