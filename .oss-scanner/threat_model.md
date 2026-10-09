# Yachiyo security review context

This document provides repository-specific security analysis context. It does not enroll the project,
enable a scan, or establish a maintainer disclosure or severity policy. Source references describe
`7f5153bb5e8f77b4effab5287383003567be5a80`; verify assumptions against the revision being reviewed.

## Product, assets, and trust assumptions

Yachiyo is a local-first Electron assistant with a privileged main process, preload, React renderer,
runtime, CLI and native helpers. It intentionally modifies files, runs commands/REPLs, uses browsers,
calls providers and communicates through channels. Paired Remote clients control part of the owner's
assistant; optional directory-based synchronization imports state and custom skills.

Protect private files/conversations, memories, configuration/SQLite state, channel workspaces,
credentials/browser sessions, Remote keys/tokens, execution authority, file/settings changes, channel
approval, tool-question answers, reply destinations and service availability.

The main process, runtime, preload implementation, and installed native helpers are trusted code;
the OS account and system credential store are relied upon. Already having arbitrary code execution
as that account differs from an unpaired network peer, channel guest, sandboxed frame, or another OS
user gaining equivalent authority through Yachiyo. An interface being local does not authenticate it.

Inputs include Remote traffic, channel content/identities, model output, fetched pages, repository
files, generated HTML/CSS/JavaScript and malformed sync files. Establish the attacker's ability to
supply them; editing configuration, installing skills or replacing helpers is a separate prerequisite.

## Priority trust boundaries

### 1. Remote pairing, transport, and RPC

Sources: `apps/desktop/src/main/remote/` (`remoteController.ts`, `remoteHttpServer.ts`,
`remoteService.ts`, `pairingStore.ts`, `pairingQrImage.ts`, `remoteCredentialMode.ts`,
`remoteConnection.ts`, `messageCodec.ts`, `noise/`, `remoteFacade.ts`, `remoteEventHub.ts`,
`attachmentStaging.ts`); `packages/shared/src/remote/`, `packages/shared/src/rpc/`;
`packages/runtime/src/app/host/remote/remoteHostOps.ts` and `remoteWorkspaceFile.ts`.

The listener defaults to loopback; enabling LAN binds it to `0.0.0.0`. Tunnel/relay access can expose
the handshake to network attackers. WebSocket upgrade is not authentication: Noise and pairing state
must gate RPC/events. Pairing offers use a random 32-byte token, expire after five minutes, and are
single-use; reconnect identifies a paired phone by its static key. QR images/URLs are temporary
credentials. Relay transport and mailbox access should not allow device impersonation or decryption.

Review unauthenticated dispatch, handshake transitions, invalid/replayed frames, token reuse and
replacement, active-connection revocation, reconnect after revocation, decompression bounds,
backpressure, pre-authentication resource exhaustion, and error/log leakage. Examine `relayAccess.ts`,
`relayHost.ts`, `relayActivation.ts`, `mailboxWriter.ts`, and `remoteNotifications.ts` in the Remote
directory for endpoint validation, bearer disclosure, revocation, and per-pairing data handling.

Method schemas and projections define the exposed API, not the complete runtime/IPC surface. Verify
allowlisting, argument validation and thread visibility across reads, mutations, search, paging,
event replay and previews. `isRemoteVisibleThread` excludes guest/group threads and sync mirrors,
while permitting local and owner-DM threads. Paired phones control the same owner's exposed assistant;
do not assume they are separate tenants. Upload IDs are explicitly pairing-scoped and single-use:
check cross-pairing consumption, chunk order/size/hash checks, filename handling and cleanup.

Remote workspace previews use `realpath`, containment checks, regular-file checks and bounded reads.
Exercise traversal, encodings, symlinks, ancestor replacement races, special files and platform path
semantics. Demonstrate reachability through an actual RPC, not fabricated privileged helper inputs.

### 2. Channel identity, authority, and isolation

Sources: `packages/runtime/src/channels/platforms/{telegram,discord,qq,qqbot}/`;
`packages/runtime/src/channels/direct/` (`channelDirectMessageRouter.ts`,
`channelDirectMessageRuntime.ts`, `directMessageService.ts`, `dmSlashCommands.ts`, `dmAskUser.ts`);
`packages/runtime/src/channels/group/` (`channelGroupRouting.ts`, `channelGroupDiscussionService.ts`,
`groupContextBuilder.ts`, `groupProbeClaudeCode.ts`); `packages/runtime/src/channels/shared/`
(`channelPolicy.ts`, `channelReply.ts`, `channelImageDownload.ts`);
`packages/runtime/src/app/domain/run/context/prepareServerRunContext.ts`,
`packages/runtime/src/app/domain/run/execution/runToolSetFactory.ts`,
`packages/runtime/src/app/domain/run/runDomain.ts`,
`packages/runtime/src/storage/threadVisibility.ts`, and `packages/runtime/src/storage/sqlite/channelRecords.ts`.

New DM users/groups are pending. Approved users have explicit guest/owner roles; owner DMs
intentionally retain broad tools. Guest runs and group tool contexts use workspace restrictions and
narrower tools. Shared guest policies list `read`, `grep`, `glob`, `webRead`, and `webSearch`. Trace the
adapter, stored role, run trigger, mode and final tool set rather than assuming identical enforcement.

Prioritize owner-identity spoofing, guest promotion, pending/blocked bypass, answering another user's
tool question, reusing another user's thread, and private context/files reaching the wrong destination.
Distinguish authenticated provider IDs from display names or prompt text. Check platform namespacing,
username-derived workspace names, collisions/traversal, group/DM transitions, retries, batching,
slash commands, handoffs and delegation. An assertion of ownership inside a message is not authority.

Tool workspace confinement is application-level. `packages/runtime/src/tools/agentTools/shared.ts`
uses lexical containment for sandboxed paths. Review filesystem operations in `readTool.ts`,
`grepTool.ts`, `globTool.ts` and other callers for symlinks and races; lexical checks are not an OS
sandbox or proof of symlink safety. An escape report should establish attacker control of the path
or link and a reachable guest/group operation.

### 3. Generated UI, renderer content, preload, and IPC

Sources: `packages/runtime/src/tools/agentTools/renderUiTool.ts`;
`apps/desktop/src/main/electron/generativeUiProtocol.ts` and `yachiyoAssetProtocol.ts`;
`apps/desktop/src/renderer/src/features/chat/components/GenerativeUiCard.tsx`;
`apps/desktop/src/renderer/src/features/chat/lib/render-ui/renderUiBoundary.ts`;
`apps/desktop/src/renderer/index.html`, `apps/desktop/src/main/index.ts`,
`apps/desktop/src/preload/index.ts`, and `apps/desktop/src/main/yachiyoGateway/` (`ipc.ts`, `ipcChannels.ts`).

Generated JavaScript deliberately executes after completion inside a restricted iframe. Execution
there alone is not XSS. The security event is escaping the frame, acquiring host preload/IPC powers,
reading files/secrets, making unauthorized network requests, navigating/opening windows, or performing
privileged actions without the host's separate action.

The fixed `yachiyo-ui://sandbox/` shell uses a nonce CSP, `sandbox allow-scripts`, no network
connections, and no nested frames/forms/objects. HTML is allowlist-sanitized. Electron adds navigation
and resource guards. The parent checks the source window before transferring a dedicated MessagePort,
validates messages and rate-limits actions/heights. Proposed links/text need an explicit host-card
click; adding text to the composer does not send it. Test stale ports, remounts, sibling frames,
source confusion, navigation/hash changes, and output-shape/size abuse.

`yachiyo-asset` deliberately serves local image paths and has `bypassCSP: true`. Trusted-host access
must not grant access inside generated UI. Exercise custom schemes, SVG/images, `http`, `file` and
WebSockets. Main windows enable sandboxing/context isolation, but host `window.api` has significant
powers. The generic `handleYachiyoIpc` wrapper does not itself check sender frames: inspect reachable
handlers and invoking-content provenance rather than assuming global authorization. Also consider
ordinary markdown, previews and browser content reaching the privileged host renderer.

### 4. Files, secrets, local endpoints, and authorized execution

Sources: `packages/runtime/src/config/` (`paths.ts`, `commandEndpoint.ts`);
`apps/desktop/src/main/cli/commandSocket.ts`; `apps/desktop/src/main/security/`
(`providerCredentials.ts`, `providerCredentialMode.ts`); `packages/runtime/src/settings/`
(`providerCredentialKey.ts`, `providerCredentialVault.ts`, `plaintextProviderCredentialVault.ts`,
`settingsStore.ts`, `providerBackup.ts`); `packages/runtime/src/tools/agentTools/` (`bashTool.ts`,
`bashSecurity.ts`, `bashSecurityShell.ts`, `injectedEnv.ts`, `jsReplTool.ts`, `pyReplTool.ts`);
`packages/runtime/src/runtime/shell/` and `packages/runtime/src/services/processBroker/`.

`YACHIYO_HOME` selects runtime data, normally `~/.yachiyo`. Review reads, backups/exports, settings
projections, subprocess environments, logs, attachments, temporary files and sync for secret leaks.
The encrypted provider vault uses AES-256-GCM and a key protected through Electron `safeStorage`.
Plaintext mode is supported explicitly and as fallback when the system store is unavailable; it uses
a separate vault and disables Remote. Its mere existence is not an authentication bypass, and not all
local data is encrypted. Check transitions, permissions, unintended fallback and Remote's mode guard.

The CLI endpoint is a Unix socket or Windows named pipe with privileged application actions, distinct
from Remote. Assess directory/socket/pipe access and cross-user reachability on the actual OS. Local
naming alone does not identify a caller. Separate trusted same-account CLI use from network exploits.

Owner-authorized shell/REPL execution is a capability. `bashSecurity.ts` supplies blacklist and
parser/scan-policy checks; Code Mode intentionally applies only the hard blacklist. This is neither
a comprehensive shell allowlist nor OS confinement. Workspace cwd, plan-mode classification, prompts
and cancellation are not kernel sandboxing. Identify the lesser-trusted input, expected authority,
enforcement bypass and resulting action. Deliberately requested owner commands are not attacker RCE;
channel/renderer/Remote authorization bypasses reaching them can nevertheless be severe.

### 5. Rust sync-core and process-host

Sources: `native/sync-core/` (`src/main.rs`, `src/lib.rs`, `src/custom_skills.rs`, `Cargo.toml`,
`Cargo.lock`); `native/process-host/` (`src/main.rs`, `src/protocol.rs`, `Cargo.toml`, `Cargo.lock`);
`packages/runtime/src/app/host/YachiyoServer.ts`, `packages/runtime/src/services/autoSyncScheduler.ts`,
`packages/runtime/src/services/processBroker/nativeProcessBroker.ts` and `processHostProtocol.generated.ts`.

`sync-core` imports/exports operations, settings and custom skills, updates SQLite, and writes local
files. Universe IDs/payload hashes are consistency checks, not sender authentication; Remote's
separate encrypted mailbox does not imply encrypted sync. Review malformed/oversized imports,
SQL/data integrity, replay/conflicts, local-only settings preservation, and exported credentials.
Custom skills have path validation, symlink checks, case/Unicode collision handling and executable-bit
tracking. Test supported filesystems, races and conflict resolution. Explain the prerequisite of
sync-account/directory access and any additional authority gained. Intentionally importing a shared
skill is not automatically unauthenticated code execution.

`process-host` is a privileged broker using line-delimited JSON on inherited stdin/stdout, not an
authenticated network service. Its parent supplies executable, args, cwd, environment and log path.
It clears inherited environment before applying supplied values, starts process groups, streams
bounded output batches, and supports cancellation/timeouts. The parent must authorize job submission.
Review parsing, job/request association, aggregate resource/disk growth, log paths, parent-loss
cleanup and platform termination. Requested process creation is expected; attacker control crossing
an authority boundary into the broker is the relevant security event.

## Finding quality and severity guidance

These suggestions are not guaranteed ratings. Include source/sink, attacker prerequisites, mode/OS,
synthetic reproduction, observed impact and relevant regression tests. Label unconfirmed hypotheses.

- Highest priority: unauthenticated Remote takeover, guest/group-to-owner escalation, generated UI
  reaching privileged IPC/execution, or reusable credentials/private files exposed to untrusted input.
- Potentially high impact: cross-conversation disclosure, unauthorized messages/file modification,
  or sync writes outside the intended boundary. Rate sensitivity, reachability and required access/
  interaction rather than the dangerous API name alone.
- Availability: establish authentication needs, realistic cost, persistence and recovery. Repeatable
  remote crash/disk fill differs from trusted local self-exhaustion or a harmless rejected frame.
- Hardening unless an exploit path is shown: unreachable helpers, intended owner tools, unattainable
  path tricks, dependency advisories without affected behavior, or same-account access gaining no
  authority beyond the attacker's existing execution.

Prompt injection alone does not prove a code vulnerability. Show the crossed authority/data boundary;
a model-mediated chain can still be an exploitable escalation.

## Verification and coverage limits

Use `.oss-scanner/README.md` and `.oss-scanner/test-offline.sh` for the intended isolated Linux image
workflow. Build dependencies/helpers online from a clean checkout, then run the prepared image with
network disabled and disposable state. Do not mount host homes, credentials, Docker sockets or real
profiles. Native preparation belongs only in the explicitly authorized disposable-image workflow;
respect `AGENTS.md` and do not rebuild the host checkout's native dependencies. `pnpm dev` is not a
safe shortcut. Use fixture credentials/in-memory storage; live accounts or Remote pairing are not
needed for the default verification.

The offline script intends to run server, Remote, renderer, native runtime and both Rust suites.
`test:server:native` invokes native preparation and helper-build scripts again, using artifacts prepared
in the image. The script's presence is not evidence that these checks passed: record the actual
revision, command, result and any skipped/blocked checks. Normal CI success does not prove this image
works offline. Node `22.22.1` and pnpm `10.30.3` are pinned by the repository.

Run focused tests with `node --experimental-strip-types --test <path/to/file.test.ts>`; useful targets
include `bashSecurity.test.ts`/`shared.test.ts` under `packages/runtime/src/tools/agentTools/`, channel
routing, and Remote host/file tests. `pnpm run test:remote` covers desktop Remote; `test:server` covers
shared/runtime/CLI but excludes `*.native.test.ts`/`*.mac.test.ts`. Include lint/typecheck/renderer checks.

The offline script omits GUI smoke coverage. `pnpm run test:generative-ui` uses
`scripts/generative-ui-smoke.ts` to exercise CSP/preload/network/file/navigation/action isolation with
working Electron/display support. Unit tests cannot prove these properties. Rust tests likewise do
not replace native process-broker integration with a prepared helper.

Linux CI in `.github/workflows/ci.yml` runs platform/Remote tests, packaging/helper checks and native
runtime tests. A minimal container is not equivalent to that job or broader macOS renderer/browser
coverage. Linux checks do not establish macOS Keychain/iCloud/automation, Windows pipe access/process
termination, real phone pairing, or iOS behavior. Linux secure pairing needs an unlocked supported
credential store; plaintext/basic fallback is not secure-pairing coverage. Reproduce platform-sensitive
findings on the relevant OS and keep gaps explicit.
