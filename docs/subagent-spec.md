# Yachiyo Subagent Architecture (ACP Based)

## 1. Core Philosophy

- **YOLO Mode**: Subagents run with auto-approval for all permissions. No human-in-the-loop (HITL) prompts block the execution.
- **Suspend & Resume**: Yachiyo (主模型) suspends reasoning while the subagent runs. No polling tools.
- **Single Tool Interface**: Only one tool (`delegate_coding_task`) is exposed to Yachiyo.
- **Context & Safety First**: Coding agents can ONLY be invoked within a valid Git repository workspace. CWD is strictly bound to the thread workspace. Yachiyo acts as the final reviewer.

## 2. Context Injection (System Prompt)

The following block is dynamically injected into Yachiyo's system prompt. It checks for a `.git` directory first.

### If Git is available:

```text
<coding_agents>
You can delegate complex coding tasks to the following ACP-compatible agents using the `delegate_coding_task` tool.
CRITICAL RULE 1: Agents MUST ONLY operate within the current thread workspace: {{THREAD_WORKSPACE_PATH}}.

Git Context:
- Current Branch: {{GIT_CURRENT_BRANCH}}
- Main Branch: {{GIT_MAIN_BRANCH}}

CRITICAL RULE 2 (PROMPT AUTHORING):
When writing the `prompt` parameter for the delegated agent, you MUST follow these constraints:
- Write strictly in English.
- Use direct, imperative natural language (e.g., "Implement X", "Ensure Y").
- Provide ONLY: the objective, current context/constraints, and acceptance criteria.
- DO NOT predefine architectural structures; let the agent decide the implementation.
- DO NOT use overly structured, markdown-heavy formatting.

Available Agents:
{{#each enabled_agent_profiles}}
- Name: "{{this.name}}" (Description: {{this.description}})
{{/each}}
</coding_agents>
```

### If Git is missing:

```text
<coding_agents>
⚠️ CRITICAL: The current workspace is NOT a Git repository.
You CANNOT use the `delegate_coding_task` tool. If the user asks you to delegate a task, inform them that a Git repository must be initialized first to ensure safe YOLO execution.
</coding_agents>
```

## 3. Tool Definition

```typescript
{
  name: "delegate_coding_task",
  description: "将代码任务委派给后端的 Coding Agent。调用后你会挂起，直到 Agent 运行完毕并返回结果。",
  parameters: {
    properties: {
      agent_name: { type: "STRING", description: "从上下文中选择的可用 Agent 名称" },
      prompt: { type: "STRING", description: "给 Agent 的具体任务描述，必须全英文，遵循规范" }
    },
    required: ["agent_name", "prompt"]
  }
}
```

## 4. Execution Lifecycle & Backend ACP Client

1. **Tool Invocation**: Yachiyo calls `delegate_coding_task`. Thread reasoning suspends.
2. **Subprocess Spawn**: Backend spawns the provider (e.g., `npx @zed-industries/claude-agent-acp`) with CWD strictly set to the thread workspace. Profile-specific `env` variables are injected.
3. **ACP JSON-RPC**: Backend acts as the ACP client.
   - **Auto-Approve**: Any `window/showMessageRequest` or permission checks from the agent are automatically answered with `Approved`/`Accept`.
   - **Event Streaming**: stdout/stderr and progress events are piped to the frontend via WebSocket/SSE.
4. **Completion**: Upon `session/close` or process exit, the backend extracts the agent's final message.

## 5. Result Payload (Resume Yachiyo)

To prevent token explosion and enforce Yachiyo's role as a reviewer, the `tool_result` returned to Yachiyo contains the agent's last message and a strict review instruction:

```json
{
  "status": "success",
  "agent_last_message": "I have completed the refactoring of NavBar.tsx and updated the tests.",
  "system_instruction": "CRITICAL: The subagent has finished its execution. Before replying to the user, you MUST use your `read`, `bash` (e.g., git status, git diff), or `grep` tools to verify the actual file changes. Do not blindly trust the agent's summary. Once verified, report your findings to the user."
}
```

## 6. Frontend UI & Interaction

- **Settings Panel**: Users define "Coding Agents" with a plain-text description, command line, args, and custom environment variables (e.g., model selection).
- **Steer Locking**: While an agent is running, Yachiyo's input field is disabled ("Agent is working...").
- **Timeline Indicator**: A `<SubagentRunningIndicator />` sits at the bottom of the timeline, showing live stdout streams from the ACP provider.
- **Hard Kill (Cancel)**: A "Cancel" button is provided. Clicking it triggers a confirmation dialog ("确定要中断当前 Agent 吗？它可能留下未完成的代码。"). If confirmed, the backend sends a `SIGKILL` to the process tree and returns a `Cancelled` tool result to Yachiyo.
