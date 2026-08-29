# Native Runtime Helpers

Native binaries called by the Electron runtime:

- `process-host`: one app-scoped resident process that owns Bash child groups, timeout/cancellation, bounded output batching, and full log I/O. Its stdout is reserved for the generated NDJSON protocol.
- `sync-core`: one-shot machine-readable commands for synchronization.
- `vision-ocr`: the macOS OCR hook.

Helpers must keep diagnostics on stderr and return machine-readable data on stdout.
