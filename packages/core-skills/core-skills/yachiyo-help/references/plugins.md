# Plugins — local execution hooks

Plugins change the context and observe or block existing tool calls in Yachiyo's native
main conversation loop. Version 1 exposes hooks only. It rejects tool registration fields.

## Write and enable a plugin

Save a single ES module in `$YACHIYO_HOME/plugins/`, which defaults to `~/.yachiyo/plugins/`.
Filenames use lowercase letters, digits, and hyphens, start with a letter, and end in
`.js`, `.mjs`, or `.ts`. TypeScript is transformed by Node; this does not type-check the file.
Modules can import Node built-ins. Relative imports and package imports are not supported
by the single-file loader. Use the supplied workspace path when reading project files.

For example, save this as `project-context.ts`:

```ts
const marker: string = '[project-context]'

export default {
  apiVersion: 1,
  hooks: {
    beforeModel({ messages, context }) {
      return {
        messages: [
          ...messages.filter(
            (message) =>
              message.role !== 'system' ||
              typeof message.content !== 'string' ||
              !message.content.startsWith(marker)
          ),
          {
            role: 'system',
            content: `${marker}\nUse the repository conventions in ${context.workspacePath}.`
          }
        ]
      }
    }
  }
}
```

Then run:

```sh
yachiyo plugin check project-context.ts
yachiyo plugin enable project-context.ts
yachiyo plugin list
```

`check` executes the module's initialization and checks its exports. It does not invoke
hooks or prove their behavior. After enabling, test the change in a new conversation turn.
The model can use its existing file and shell tools for this entire workflow.

`enable` checks the file before saving it to the ordered `plugins.enabled` list in
`config.toml`. `disable` removes it without loading or executing the file:

```sh
yachiyo plugin disable project-context.ts
```

This also recovers from a broken plugin that prevents replies. Both files and enablement
are local to the device. Configuration sync does not enable plugins on another device.
With `--settings /path/config.toml`, CLI commands use `/path/plugins/`.

## Hook contract

The default export has exactly two fields: `apiVersion: 1` and `hooks`. Hooks may be async.
Unknown fields, unknown hooks, unsupported versions, and malformed results fail visibly.

| Hook          | Input                                                                                                       | Allowed result                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `beforeModel` | `context`, `messages`, `stepNumber`                                                                         | `{ messages }` replaces the model context; `undefined` leaves it unchanged |
| `beforeTool`  | `context`, `toolName`, `toolCallId`, `input`                                                                | `{ block: 'reason' }` prevents execution; `undefined` allows it            |
| `afterTool`   | The tool-call fields, `context`, and either `{ status: 'success', output }` or `{ status: 'error', error }` | `undefined`; observe results or update plugin state                        |

`context` contains `runId`, `threadId`, `workspacePath`, and `runMode`. It does not contain
provider credentials or live runtime objects. Tools return their existing output shapes.
`status: 'success'` means execution returned normally; a tool may still report a domain
failure in its output. `afterTool` receives the last result of a streaming tool. A call
blocked by `beforeTool` does not execute and does not fire `afterTool`.

`beforeModel` runs before **each model step**, including steps following tool results.
Hooks run in `plugins.enabled` order. Each context hook sees the previous hook's result.
The replacement context carries forward to later steps, so replace your own context block
instead of appending duplicates. Keep matching tool-call/result pairs, media, and provider
reasoning metadata intact when filtering history. Only the request context changes;
stored conversation messages are not rewritten. URL values cross the worker as strings;
binary media retain their bytes.

Tool hooks apply to the existing tool set, including tools called through the JavaScript
and Python REPLs. They cannot add tools, replace implementations, change schemas, or enable
disabled tools. Use `beforeModel` to change how tool results are presented in subsequent
model context. `afterTool` does not rewrite the recorded result.

## Lifetime and failures

The runtime captures plugin source at the first execution leg of a run. Edits and enablement
changes take effect on the next run. Steers and retries within that live run retain the
captured source. Each execution leg gets a fresh worker; module variables are local to that
leg. Recovery after an app-server restart reads the current files again.

Plugins run for local conversations and owner direct messages. Guest/group conversations,
ephemeral recaps, auxiliary model calls, worker subagents, and ACP-managed conversations do
not load them. Plugin code is trusted local Node code with the user's filesystem and network
access. The worker allows interruption; it is not an OS security sandbox.

Module initialization and each hook have a ten-second deadline. Cancellation, worker exit,
and timeout reject pending hook calls and terminate the worker. Hook errors identify the
plugin and operation. A context-hook failure stops the reply; a tool-hook failure appears
as a tool error. Completed external effects are not rolled back. Disable the plugin through
the CLI, correct its source, and check it before enabling it again.
