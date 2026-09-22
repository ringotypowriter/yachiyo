import { z } from 'zod'

import {
  activeRunEnterBehaviorSchema,
  modelOverrideSchema,
  reasoningSelectionSchema,
  remoteEndpointSchema,
  runModeSchema,
  themeAppearanceSchema,
  themeIdSchema
} from './common.ts'
import { remoteEventSchema, remotePushSchema } from './events.ts'
import { mailboxPlaintextSchema } from './mailbox.ts'
import { remoteChatAcceptedSchema, remoteMethods, REMOTE_METHOD_NAMES } from './methods.ts'
import {
  handshakeClientPayloadSchema,
  pairingGrantSchema,
  pairingPayloadSchema
} from './pairing.ts'
import {
  remoteAppearanceSchema,
  remoteEssentialSchema,
  remoteFileRefSchema,
  remoteImageRefSchema,
  remoteMessageSchema,
  remoteRunStatusSchema,
  remoteSearchResultSchema,
  remoteSelectableModelSchema,
  remoteTaskSchema,
  remoteThreadCapabilitiesSchema,
  remoteThreadDetailSchema,
  remoteThreadSummarySchema,
  remoteTodoItemSchema,
  remoteToolCallSchema,
  remoteToolQuestionSchema,
  remoteWorkspaceSchema
} from './projections.ts'

const NAMED_SCHEMAS: z.ZodType[] = [
  reasoningSelectionSchema,
  runModeSchema,
  modelOverrideSchema,
  themeIdSchema,
  themeAppearanceSchema,
  activeRunEnterBehaviorSchema,
  remoteEndpointSchema,
  pairingPayloadSchema,
  handshakeClientPayloadSchema,
  pairingGrantSchema,
  mailboxPlaintextSchema,
  remoteRunStatusSchema,
  remoteThreadCapabilitiesSchema,
  remoteThreadSummarySchema,
  remoteImageRefSchema,
  remoteFileRefSchema,
  remoteMessageSchema,
  remoteToolQuestionSchema,
  remoteToolCallSchema,
  remoteTodoItemSchema,
  remoteThreadDetailSchema,
  remoteSelectableModelSchema,
  remoteEssentialSchema,
  remoteAppearanceSchema,
  remoteTaskSchema,
  remoteWorkspaceSchema,
  remoteSearchResultSchema,
  remoteEventSchema,
  remotePushSchema,
  remoteChatAcceptedSchema
]

function methodTypeName(method: string, suffix: 'Input' | 'Output'): string {
  const pascal = method
    .split('.')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
  return `Remote${pascal}${suffix}`
}

type JsonObject = Record<string, unknown>

/**
 * One JSON Schema document with every protocol type under `$defs`, used to generate the
 * Swift client types. Output is deterministic so CI can diff regenerated files.
 */
export function buildRemoteProtocolJsonSchema(): JsonObject {
  const registry = z.registry<{ id: string }>()

  for (const schema of NAMED_SCHEMAS) {
    const id = z.globalRegistry.get(schema)?.id
    if (!id) throw new Error('Named remote schema is missing a meta id.')
    registry.add(schema, { id })
  }
  const methodTypes: Record<string, { input: string; output: string }> = {}
  const idOf = (schema: z.ZodType, fallback: string): string => {
    const existing = registry.get(schema)?.id ?? z.globalRegistry.get(schema)?.id
    const id = existing ?? fallback
    if (!registry.has(schema)) registry.add(schema, { id })
    return id
  }
  for (const method of REMOTE_METHOD_NAMES) {
    const { input, output } = remoteMethods[method]
    methodTypes[method] = {
      input: idOf(input, methodTypeName(method, 'Input')),
      output: idOf(output, methodTypeName(method, 'Output'))
    }
  }

  const { schemas } = z.toJSONSchema(registry, {
    target: 'draft-2020-12',
    uri: (id) => `#/$defs/${id}`,
    unrepresentable: 'throw'
  })

  const defs: JsonObject = {}
  for (const id of Object.keys(schemas).sort()) {
    const entry = { ...(schemas[id] as JsonObject) }
    delete entry.$schema
    delete entry.$id
    delete entry.id
    defs[id] = entry
  }

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://yachiyo.ringo.sh/schemas/remote-protocol.json',
    title: 'YachiyoRemoteProtocol',
    'x-methods': methodTypes,
    $defs: defs
  }
}
