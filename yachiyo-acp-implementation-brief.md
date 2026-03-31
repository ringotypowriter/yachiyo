# Yachiyo ACP Implementation Brief (For Claude Code)

This brief extends `yachiyo-acp-dual-path-spec.md` by providing hard constraints and type contracts for implementation. Follow these steps sequentially.

## Hard Contracts

### 1. Drizzle Schema Updates (`src/main/yachiyo-server/storage/sqlite/schema.ts`)
Add a serialized JSON field to `threadsTable` to store the thread's runtime mode and ACP session data:
```typescript
runtimeBinding: text('runtime_binding'), // Stores serialized ThreadRuntimeBinding
```

### 2. ACP Types (`src/main/yachiyo-server/runtime/acp/acpTypes.ts`)
```typescript
export interface ThreadRuntimeBinding {
  kind: 'llm' | 'acp'
  profileId?: string
  profileName?: string
  sessionId?: string
  sessionStatus?: 'new' | 'active' | 'expired'
  lastSessionBoundAt?: string
}

export interface AcpProfileExt {
  // Add to existing SubagentProfile or CodingAgent config in shared/yachiyo/protocol.ts
  showInChatPicker?: boolean
  allowDelegation?: boolean
  allowDirectChat?: boolean
}
```

### 3. ACP Protocol Signature (`@agentclientprotocol/sdk`)
Yachiyo uses `@agentclientprotocol/sdk`. The essential calls inside `ClientSideConnection` are:
```typescript
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from '@agentclientprotocol/sdk'

// connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
// connection.newSession({ capabilities: {}, prompt: string }) -> returns { sessionId }
// connection.unstable_resumeSession({ sessionId: string }) -> returns void
// connection.prompt({ sessionId: string, prompt: string }) -> returns { stopReason }
// connection.cancel({ sessionId: string, reason: string })
```

## Implementation Steps

### Step 1: Schema & Types
- Add `runtimeBinding` to `threadsTable` in `schema.ts`.
- Update `SubagentProfile` in `src/shared/yachiyo/protocol.ts` to include `showInChatPicker`, `allowDelegation`, `allowDirectChat` (default `allowDelegation: true` for backward compatibility).
- Create `src/main/yachiyo-server/runtime/acp/acpTypes.ts` with `ThreadRuntimeBinding` and necessary context interfaces.

### Step 2: Shared ACP Backbone (`src/main/yachiyo-server/runtime/acp/`)
- Extract logic from `delegateCodingTaskTool.ts` into reusable modules:
  - `acpLauncher.ts` (handles `spawn`, env merging, and returning stdio streams)
  - `acpSessionClient.ts` (wraps `ClientSideConnection`, handles `initialize`, `newSession`, `unstable_resumeSession`, `prompt`)
  - `acpStreamAdapter.ts` (converts `SessionNotification` to Yachiyo progress/delta callbacks)

### Step 3: Refactor Delegate Tool
- Rewrite `src/main/yachiyo-server/tools/agentTools/delegateCodingTaskTool.ts` to strictly consume the new shared backbone modules (`acpLauncher`, `acpSessionClient`). Ensure the exact same behavior (spawning, yielding summary, etc.) is preserved.

### Step 4: Direct ACP Chat Runtime
- Implement `acpChatRuntime.ts`. It should export a function like `runAcpChatThread(...)` that parallels the existing AI SDK LLM run logic but routes `chat.send` through `newSession`/`unstable_resumeSession` and `prompt`.
- Inject the `ThreadRuntimeBinding` update logic into the run lifecycle so session IDs are saved back to the database.

### Step 5: Frontend Updates
- Update the Model Selector Zustand store (`src/renderer/src/features/chat/lib/modelSelectorState.ts`) to group standard LLMs and ACP Agents (`showInChatPicker: true`).
- Update `Composer.tsx` and thread metadata components to display the ACP agent indicator.

## Rules
- Work exclusively in English.
- Use direct implementation without markdown verbosity.
- Stick to the existing Drizzle and AI SDK stack. Do not introduce new libraries.
- YOLO mode is acceptable for local workspace changes.
