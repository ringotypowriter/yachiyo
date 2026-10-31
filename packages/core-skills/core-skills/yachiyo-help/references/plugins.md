# Plugins — programmable harness hooks

Plugins customize input, context, model calls, output, compaction and execution flow in
Yachiyo's native runtime. They can observe or block existing tool calls. The host owns tool
registration, schemas, implementations, availability and permissions.

## Write, trial and activate

Save a single ES module in `$YACHIYO_HOME/plugins/` (default `~/.yachiyo/plugins/`). Names
start with a lowercase letter, contain lowercase letters, digits or hyphens, and end in
`.js`, `.mjs` or `.ts`. Node transforms TypeScript; it does not type-check the source.
Node built-in imports work. Relative and package imports are not supported by the
single-file loader. Read project files through `context.workspacePath`.

For example, save `project-context.ts`:

```ts
const marker: string = '[project-context]'

export default {
  apiVersion: 1,
  hooks: {
    runStart({ maxSteps }) {
      return { maxSteps: Math.min(maxSteps, 20) }
    },
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

Create a fixture, for example `/tmp/plugin-trial.json`:

```json
{
  "events": [
    { "hook": "runStart", "event": { "maxSteps": 999 } },
    {
      "hook": "beforeModel",
      "event": {
        "messages": [{ "role": "user", "content": "Inspect this project" }],
        "stepNumber": 0
      }
    },
    { "hook": "runEnd", "event": { "status": "completed" } }
  ]
}
```

```sh
yachiyo plugin check project-context.ts
yachiyo plugin trial project-context.ts /tmp/plugin-trial.json
yachiyo plugin enable project-context.ts
yachiyo plugin status project-context.ts
```

`check` imports the draft and validates its exports. `trial` also executes the supplied hook
events, validates results and reports their duration. Events run in fixture order in one
worker. Fixture events are explicit inputs; one event's result is reported, not automatically
copied into the next fixture event. Managed state is temporary during a trial. No provider
or tool is called by the trial runner. Plugin code still has ordinary Node access and can
perform its own filesystem or network operations.

A fixture can supply `context` with `runId`, `threadId`, `workspacePath` and `runMode`.
Its purpose is always `trial`. Live model-loop behavior should also be checked in a new
conversation turn. The assistant uses its existing file and shell tools for this workflow.

`enable` checks and stores an immutable source revision, then adds the filename to the
ordered `plugins.enabled` list in `config.toml`. Editing the draft does not change that
revision. Publish subsequent edits with `activate` (which also enables a disabled plugin):

```sh
yachiyo plugin activate project-context.ts
yachiyo plugin history project-context.ts
yachiyo plugin rollback project-context.ts           # restore the previous active revision
yachiyo plugin rollback project-context.ts <sha256>  # select a retained revision
yachiyo plugin disable project-context.ts
```

`rollback` and `disable` do not load plugin code. Rollback changes the active revision and
preserves enablement. It does not overwrite the draft or undo state writes and external
effects. `list` reports draft files and enablement. `status` includes active/previous
revisions and recent run diagnostics. A missing draft does not remove an activated source.

Changes take effect on the next run. Previously enabled files without an activation record
are pinned on their first run after upgrading. Later edits require `activate`. Revisions,
state, diagnostics and enablement stay local to the device. Configuration sync excludes
`plugins`. With `--settings /path/config.toml`, CLI commands use `/path/plugins/`.

## Hook contract

The default export has exactly `apiVersion: 1` and `hooks`. Hooks may be async. Unknown
fields, unknown hooks and malformed results fail visibly. Returning `undefined` leaves the
input unchanged. Hooks run in `plugins.enabled` order. Transform hooks pass their result
to the next plugin. Model option fields merge; a stop decision cannot be undone by a later
plugin.

Every event includes `context`: `runId`, `threadId`, `workspacePath`, `runMode`, and `purpose`
(`chat`, `subagent`, `compaction`, or `trial`). The event contains no provider credentials or
live tool objects. The second argument is the state API described below.
The [TypeScript contract](../../../../runtime/src/services/plugins/pluginTypes.ts) defines the complete event and result shapes.

| Hook            | Event fields beyond `context`                                                        | Allowed result                                                                      |
| --------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `runStart`      | `maxSteps`                                                                           | `{ maxSteps }`, a positive model-loop step cap no higher than the host limit        |
| `beforeInput`   | `text`                                                                               | `{ text }` for the current request context                                          |
| `beforeModel`   | `messages`, `stepNumber`, `model`, `availableModels`, `options`                      | Any of `{ messages, model, options }`                                               |
| `afterStep`     | `stepNumber`, `text`, `finishReason`, `messages`, `usage`                            | `{ stop, messages, compact }`                                                       |
| `textDelta`     | `text`, `stepNumber`                                                                 | `{ text }`                                                                          |
| `beforeCompact` | `kind`, `messages`, optional `thresholdTokens`, `summary`, `skip`                    | `{ messages, thresholdTokens, summary, skip }` as applicable to the compaction kind |
| `afterCompact`  | Same compaction fields, including the result                                         | `{ messages }` for strip compaction; `{ summary }` for handoff                      |
| `beforeTool`    | `toolName`, `toolCallId`, `input`                                                    | `{ block: 'reason' }`                                                               |
| `afterTool`     | Tool-call fields and `{ status: 'success', output }` or `{ status: 'error', error }` | `undefined`                                                                         |
| `runEnd`        | `status`                                                                             | `undefined`                                                                         |

`beforeInput` runs during context preparation, after attachment/reference expansion. It
changes the request presented to the model, while the stored user message remains intact.
Context may be prepared again after a handoff or steer.

`beforeModel` runs before every model step. `stepNumber` is zero-based within the current
model call loop. `model` is `{ providerName, model }`; choose from `availableModels`, which
contains only enabled models. The host resolves credentials. Options are `temperature`,
`topP`, `topK`, `maxOutputTokens`, `presencePenalty`, `frequencyPenalty`, `stopSequences`,
`seed` and `reasoningEffort` (`off`, `low`, `medium`, `high`, `xhigh`, `max`). Provider/model
support still applies. Model and option changes carry forward through that loop. They do
not rewrite configured providers or the thread's selected model.

Replacement messages carry forward through the loop. Replace your own context block to
avoid duplicates. Preserve matching tool-call/result pairs, media and provider reasoning
metadata. URL values cross the worker as strings; binary media retain their bytes.
Stored conversation messages are not rewritten by context hooks.

`afterStep` runs after the model and its tools finish. It receives full context including
that step's response, plus `usage.promptTokens` and `usage.completionTokens`. `stop: true`
ends the loop at this boundary. `messages` replaces context for the next step.
`compact: true` runs strip compaction before the next step. These results do not force
another model call after a natural final answer, and cannot override cancellation or the
host's step budget.

`textDelta` transforms each streamed text chunk before it reaches the UI, step hooks and
replay history. Chunks are arbitrary fragments, not sentences. Use `beforeModel` for future
context changes. Streaming text transforms must not depend on a complete final answer.

`kind: 'strip'` compacts context in memory. Plugins can change messages, its token threshold,
or `skip` the built-in pass. `kind: 'handoff'` creates a stored checkpoint: change the
summary prompt with `messages`, or supply a nonempty `summary` to bypass the summary model.
`afterCompact` can replace the resulting summary before it is persisted. Automatic handoff
can be skipped; declining an explicit handoff reports a failure. Worker handoff hooks can
also adjust their compaction threshold. Checkpoint watermarks advance only after hooks
complete successfully.

Tool hooks cover direct calls and REPL tool access. They cannot register or replace tools,
change inputs/schemas, enable disabled tools or change the recorded result. Present a tool
result differently through a subsequent context hook. `afterTool` observes the final result
of a streaming tool. `status: 'success'` means execution returned normally; the output may
still describe a domain failure. A blocked call does not execute or fire `afterTool`.

## Persistent state

Hooks receive `api.state` as their second argument. Always await its operations:

```ts
async function rememberStep(event, { state }) {
  const previous = await state.read('thread', 'last-step')
  await state.write('thread', 'last-step', previous.version, {
    text: event.text,
    tokens: event.usage.completionTokens
  })
}
```

Assign this function to `afterStep`. Reads return `{ version, value }`, initially
`{ version: 0, value: null }`. Writes require the version that was read and return the new
record. A concurrent writer causes an explicit conflict; read again before retrying.
Use `null` to clear a value. Values must be JSON and each record must fit in 1 MiB.

| Scope       | Lifetime and sharing                                                           |
| ----------- | ------------------------------------------------------------------------------ |
| `run`       | In memory across live run legs; isolated by run ID; reset after server restart |
| `thread`    | Persistent, shared by this thread and its Worker tasks                         |
| `workspace` | Persistent, shared by the same workspace path                                  |
| `plugin`    | Persistent, shared by all runs of this plugin on this device                   |

Each plugin has its own namespace. Persistent writes publish complete numbered records
atomically, so concurrent runtime/CLI processes cannot silently overwrite each other.
State history is retained under `plugins/.state`. Activation history is under `.releases`,
immutable source JSON under `.versions`. Rollback does not migrate or reset state; keep
state formats compatible across revisions you may restore.

## Lifetime, diagnostics and recovery

A live main run captures enabled sources once. Steers/retries retain that snapshot.
`runStart` fires once, and a healthy worker retains module variables across legs. If
cancellation or a timeout terminates the worker, the next leg creates a fresh worker from
the same sources; use scoped state for values that must survive that replacement.
`runEnd` observes the final outcome. A terminated worker cannot run end hooks. End-hook
errors are logged and recorded without changing an already persisted run outcome.

Worker subagents capture sources per turn and use their turn ID for run state. Native
main runs, owner DMs, Worker turns and context-handoff calls support plugins. Guest/group
runs, ephemeral recaps, unrelated auxiliary calls such as title generation, and ACP-owned
loops do not load them. ACP owns its model loop outside Yachiyo.

Initialization and each hook have a ten-second deadline. Cancellation, worker exit and
timeout reject pending hooks and terminate the worker. Plugin failures do not trigger
provider retries or provider context-window recovery. Context/model-hook failures stop the
reply; tool-hook failures surface as tool errors. Completed state writes and external effects
remain committed.

Diagnostics contain revision, run outcome, hook counts, duration and errors. They omit event
payloads. The latest twenty run reports per plugin are retained in `.diagnostics`; `status`
shows the latest five. Use `rollback` to restore working code, or `disable` to stop loading
it. There is no silent fallback to an older revision.

Plugin code is trusted local Node code with the user's filesystem and network access. The
worker provides interruption, not an OS sandbox. Source pinning covers the plugin file;
files or services it reads at runtime remain external dependencies.

## Extension references

This interface covers the lifecycle, context, request configuration and compaction surfaces
found in [Pi extensions](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
and [OpenCode plugins](https://opencode.ai/docs/plugins/). Persistent extension state also
appears in [OpenCode's development server-plugin API](https://dev.opencode.ai/v2/docs/build/plugins/server).
[Claude Code hooks](https://code.claude.com/docs/en/hooks) provide another lifecycle-hook
reference. These are design references, not compatible plugin formats.
