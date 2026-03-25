# Yachiyo Subagent Architecture (ACP)

## 1. Overview

Yachiyo delegates complex coding tasks to external coding agents (e.g., Claude Code, Codex) using the Agent Client Protocol (ACP). Yachiyo acts as the Orchestrator/Client, and the external CLIs act as ACP Servers via `stdio`.

## 2. Context & Constraints (The Git Gate)

Subagents can ONLY be invoked in a valid Git repository.
Before injecting the `delegate_coding_task` tool into Yachiyo's context, the backend must check for `.git`.

- **If no `.git`**: Inject a critical rule stating the tool is disabled because a Git repository is required.
- **If `.git` exists**: Inject the available agent profiles and the Git context (Current branch, Main branch).

## 3. Agent Profiles (Settings Registry)

Users configure Subagents in a Settings panel. The profile determines how the ACP server is spawned.

```typescript
interface SubagentProfile {
  id: string
  name: string
  enabled: boolean
  description: string // Plain text injected into Yachiyo's prompt context
  command: string // e.g., "npx" or "acpx"
  args: string[] // e.g., ["-y", "@zed-industries/claude-agent-acp"]
  env: Record<string, string> // e.g., for overriding ANTHROPIC_MODEL
}
```

## 4. The Tool: `delegate_coding_task`

Yachiyo exposes exactly **one** tool for this domain:

- `agent_name`: String (matches an enabled profile).
- `prompt`: String. Must strictly contain the objective, constraints, and acceptance criteria in English. No architectural pre-definitions.

## 5. Execution Lifecycle (Suspend & Resume)

We do NOT use polling. We use a synchronous block for the LLM and asynchronous streaming for the UI.

1. **Suspend**: Yachiyo invokes `delegate_coding_task`. The LLM inference pauses.
2. **Spawn**: The backend spawns the profile's command.
   - **SECURITY**: `cwd` is strictly set to the current Thread Workspace.
3. **ACP Connection**: The backend uses `@agentclientprotocol/sdk` to establish a JSON-RPC connection over the child process's `stdio`.
4. **YOLO Mode (Auto-Approve)**: The backend ACP Client must intercept all permission requests from the ACP Server (e.g., file edits, bash commands) and automatically return `Approved`/`Accept`. No Human-in-the-loop dialogs.
5. **UI State**: The frontend locks user input (Yachiyo steer disabled) and displays a `<SubagentRunningIndicator />` with streaming stdout/progress at the bottom of the timeline. A "Cancel" button with a confirmation dialog is provided.
6. **Resume**:
   - When the agent finishes (or is killed via Cancel), the backend extracts the **last turn summary** from the agent's output.
   - The backend kills the child process.
   - The summary is returned to Yachiyo as the `tool_result`.
7. **Verification**: The tool definition MUST instruct Yachiyo to manually verify the changes (e.g., via `bash git diff` or `read`) before confidently reporting success to the user.
