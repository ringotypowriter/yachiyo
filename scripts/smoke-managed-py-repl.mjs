#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'

import {
  ensureManagedPythonRuntime,
  ensurePythonRuntime,
  PY_REPL_PREINSTALLED_PACKAGES
} from '../packages/runtime/src/services/python/managedPythonRuntime.ts'
import {
  NativeProcessBroker,
  resolveProcessHostBinary
} from '../packages/runtime/src/services/processBroker/nativeProcessBroker.ts'
import { createTool as createPyReplTool } from '../packages/runtime/src/tools/agentTools/pyReplTool.ts'

const repoRoot = resolve(import.meta.dirname, '..')
const pngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lVx9wQAAAABJRU5ErkJggg=='
const transportKeys = [
  'YACHIYO_PY_REPL_PARENT_PID',
  'YACHIYO_PY_REPL_BRIDGE_URL',
  'YACHIYO_PY_REPL_BRIDGE_TOKEN',
  'YACHIYO_PY_REPL_UV_PATH'
]

function textOf(output) {
  return output.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function parseLastJsonLine(value) {
  const lines = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  assert.ok(lines.length > 0, 'Expected JSON output from the Python kernel.')
  return JSON.parse(lines.at(-1))
}

function assertSucceeded(output, label) {
  assert.equal(output.error, undefined, `${label}: ${output.error ?? textOf(output)}`)
  return output
}

function assertReset(output, label) {
  assert.equal(output.details.contextReset, true, `${label} did not reset the Python context.`)
}

function isWithin(parent, candidate) {
  const path = relative(parent, candidate)
  return path === '' || (!path.startsWith(`..${delimiter}`) && path !== '..' && !isAbsolute(path))
}

function restoreEnvironment(snapshot) {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, snapshot)
}

function quoteShell(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function createPoisonCommands(directory, hitPath) {
  await mkdir(directory, { recursive: true })
  const commands = ['python', 'python3', 'pip', 'pip3', 'uv']
  if (process.platform === 'win32') {
    for (const command of commands) {
      await writeFile(
        join(directory, `${command}.cmd`),
        `@echo %~f0>>"${hitPath}"\r\n@exit /b 97\r\n`,
        'utf8'
      )
    }
    return
  }
  for (const command of commands) {
    const path = join(directory, command)
    await writeFile(
      path,
      `#!/bin/sh\nprintf '%s\\n' "$0" >> ${quoteShell(hitPath)}\nexit 97\n`,
      'utf8'
    )
    await chmod(path, 0o700)
  }
}

function windowsRegistrySnapshot() {
  if (process.platform !== 'win32') return undefined
  const systemRoot = process.env['SystemRoot'] ?? process.env['WINDIR']
  assert.ok(systemRoot, 'Windows registry smoke requires SystemRoot or WINDIR.')
  const regPath = join(systemRoot, 'System32', 'reg.exe')
  assert.ok(isAbsolute(regPath), 'reg.exe snapshot must use an absolute executable path.')
  assert.ok(existsSync(regPath), `reg.exe is unavailable at ${regPath}.`)
  const result = spawnSync(regPath, ['query', 'HKCU\\Software\\Python', '/s', '/reg:64'], {
    encoding: 'utf8',
    windowsHide: true
  })
  return {
    executable: regPath,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message
  }
}

async function findUvShims(root) {
  const matches = []
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && /^(?:uv|uv\.exe)$/iu.test(entry.name)) matches.push(path)
    }
  }
  await visit(root)
  return matches
}

async function main() {
  const originalEnvironment = { ...process.env }
  const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'yachiyo-managed-py-repl-')))
  const homePath = join(temporaryRoot, 'home')
  const yachiyoHome = join(temporaryRoot, 'yachiyo-home')
  const workspacePath = join(temporaryRoot, 'workspace')
  const nestedPath = join(workspacePath, 'nested')
  const poisonPath = join(temporaryRoot, 'poison-bin')
  const poisonHitPath = join(temporaryRoot, 'poison-hit.log')
  const decoyEnvironmentPath = join(temporaryRoot, 'decoy-venv')
  const wheelName = 'yachiyo_smoke_pkg-0.1.0-py3-none-any.whl'
  let registryBefore
  let registryAfter
  let broker
  let repl
  let selectedWorkspaceRuntime
  let primaryError
  const cleanupErrors = []

  try {
    await Promise.all([
      mkdir(homePath, { recursive: true }),
      mkdir(yachiyoHome, { recursive: true }),
      mkdir(nestedPath, { recursive: true }),
      mkdir(decoyEnvironmentPath, { recursive: true })
    ])
    await createPoisonCommands(poisonPath, poisonHitPath)
    await writeFile(join(nestedPath, 'localmod.py'), 'VALUE = 73\n', 'utf8')
    await writeFile(join(nestedPath, 'sample.txt'), 'first\nsecond\nthird\n', 'utf8')

    process.env['YACHIYO_HOME'] = yachiyoHome
    process.env['HOME'] = homePath
    process.env['USERPROFILE'] = homePath
    process.env['VIRTUAL_ENV'] = decoyEnvironmentPath
    process.env['PATH'] = `${poisonPath}${delimiter}${originalEnvironment['PATH'] ?? ''}`
    if (process.platform === 'win32') process.env['Path'] = process.env['PATH']

    registryBefore = windowsRegistrySnapshot()
    const processHostPath = resolveProcessHostBinary()
    broker = new NativeProcessBroker({ binaryPath: processHostPath })
    await broker.start()

    const probeCalls = []
    const tools = {
      probe: {
        execute: async (input, options) => {
          probeCalls.push({
            input,
            options,
            abortedAtInvocation: options.abortSignal?.aborted
          })
          return input
        }
      },
      write: {
        execute: async (input) => {
          assert.equal(typeof input?.path, 'string')
          assert.equal(typeof input?.content, 'string')
          assert.ok(isWithin(workspacePath, input.path), 'Nested write escaped the workspace.')
          await writeFile(input.path, input.content, 'utf8')
          return `wrote ${basename(input.path)}`
        }
      },
      slow: {
        execute: async (_input, options) =>
          await new Promise((resolvePromise, rejectPromise) => {
            const signal = options.abortSignal
            if (signal?.aborted) {
              rejectPromise(signal.reason ?? new Error('slow tool aborted'))
              return
            }
            signal?.addEventListener(
              'abort',
              () => rejectPromise(signal.reason ?? new Error('slow tool aborted')),
              { once: true }
            )
          })
      }
    }
    const context = {
      workspacePath,
      processBroker: broker,
      enabledTools: ['read', 'write'],
      isModelImageCapable: true
    }
    let managedRuntime
    repl = createPyReplTool(context, {
      listToolNames: () => ['read', 'write', 'probe', 'slow', 'pyRepl', 'jsRepl'],
      resolveTool: (name) => tools[name],
      ensureRuntime: async (options) => {
        managedRuntime = await ensureManagedPythonRuntime({
          ...options,
          yachiyoHome
        })
        return managedRuntime
      }
    })

    let callNumber = 0
    const executeCell = async (code, input = {}, abortSignal) =>
      await repl.execute(
        { code, ...input },
        {
          toolCallId: `py-repl-smoke-${++callNumber}`,
          messages: [],
          ...(abortSignal ? { abortSignal } : {})
        }
      )
    const runCell = async (code, input = {}, abortSignal) =>
      assertSucceeded(
        await executeCell(code, input, abortSignal),
        input.title ?? `cell ${callNumber}`
      )

    const environmentOutput = await runCell(`
import json, os, shutil, subprocess, sys
transport_direct = sorted(key for key in os.environ if key.startswith("YACHIYO_PY_REPL_"))
transport_child = json.loads(subprocess.check_output([
    sys.executable,
    "-c",
    "import json, os; print(json.dumps(sorted(k for k in os.environ if k.startswith('YACHIYO_PY_REPL_'))))",
], text=True))
print(json.dumps({
    "version": ".".join(str(value) for value in sys.version_info[:3]),
    "executable": os.path.realpath(sys.executable),
    "prefix": os.path.realpath(sys.prefix),
    "basePrefix": os.path.realpath(sys.base_prefix),
    "whichPython": os.path.realpath(shutil.which("python")),
    "whichPip": os.path.realpath(shutil.which("pip")),
    "subprocessPython": os.path.realpath(subprocess.check_output([
        sys.executable,
        "-c",
        "import os, sys; print(os.path.realpath(sys.executable))",
    ], text=True).strip()),
    "virtualEnv": os.environ.get("VIRTUAL_ENV"),
    "transportDirect": transport_direct,
    "transportChild": transport_child,
}, sort_keys=True))
21 * 2
`)
    assert.ok(managedRuntime, 'The pyRepl tool did not provision its managed runtime.')
    assert.equal(environmentOutput.details.result, '42')
    const runtimeInfo = parseLastJsonLine(environmentOutput.details.stdout ?? '')
    const canonicalRuntimeRoot = await realpath(managedRuntime.rootPath)
    const canonicalEnvironment = await realpath(managedRuntime.environmentPath)
    const canonicalInstallations = await realpath(join(canonicalRuntimeRoot, 'installations'))
    for (const path of [
      runtimeInfo.executable,
      runtimeInfo.prefix,
      runtimeInfo.whichPython,
      runtimeInfo.whichPip,
      runtimeInfo.subprocessPython
    ]) {
      assert.ok(isWithin(canonicalRuntimeRoot, await realpath(path)), `${path} is not private.`)
    }
    assert.equal(await realpath(runtimeInfo.prefix), canonicalEnvironment)
    assert.ok(
      isWithin(canonicalInstallations, await realpath(runtimeInfo.basePrefix)),
      `sys.base_prefix left private installations: ${runtimeInfo.basePrefix}`
    )
    assert.equal(runtimeInfo.version, managedRuntime.version)
    assert.equal(runtimeInfo.virtualEnv, managedRuntime.environmentPath)
    assert.deepEqual(runtimeInfo.transportDirect, [])
    assert.deepEqual(runtimeInfo.transportChild, [])
    assert.notEqual(await realpath(runtimeInfo.prefix), await realpath(decoyEnvironmentPath))
    for (const key of transportKeys) assert.equal(process.env[key], undefined)

    const bridgeOpenerProbe = spawnSync(
      managedRuntime.pythonPath,
      [
        '-I',
        '-c',
        String.raw`
import importlib.util
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

response_body = json.dumps({"ok": True, "value": {"proxyFree": True}}).encode()

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response_body)))
        self.end_headers()
        self.wfile.write(response_body)

    def log_message(self, _format, *_args):
        pass

server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.handle_request, daemon=True).start()
os.environ.update({
    "YACHIYO_PY_REPL_PARENT_PID": str(os.getppid()),
    "YACHIYO_PY_REPL_BRIDGE_URL": f"http://127.0.0.1:{server.server_port}/tool",
    "YACHIYO_PY_REPL_BRIDGE_TOKEN": "0" * 64,
    "YACHIYO_PY_REPL_UV_PATH": sys.argv[2],
    "HTTP_PROXY": "http://127.0.0.1:1",
    "http_proxy": "http://127.0.0.1:1",
})
os.environ.pop("NO_PROXY", None)
os.environ.pop("no_proxy", None)
spec = importlib.util.spec_from_file_location("yachiyo_runner_probe", sys.argv[1])
assert spec is not None and spec.loader is not None
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
runner._CURRENT_CELL_ID.set("proxy-probe")
runner._CURRENT_TOOLS.set(frozenset(("probe",)))

def ambient_urlopen(*_args, **_kwargs):
    raise AssertionError("ambient urllib opener used")

runner.urllib.request.urlopen = ambient_urlopen
status = 1
try:
    result = runner._bridge_call("probe", {"value": 17})
    status = 0 if result == {"proxyFree": True} else 1
except BaseException:
    pass
finally:
    server.server_close()
os._exit(status)
`,
        resolve(repoRoot, 'packages/runtime/src/tools/agentTools/pyReplRunner.py'),
        managedRuntime.uvPath
      ],
      {
        cwd: workspacePath,
        encoding: 'utf8',
        env: { ...managedRuntime.env },
        timeout: 30_000,
        windowsHide: true
      }
    )
    assert.equal(
      bridgeOpenerProbe.status,
      0,
      `The Python bridge used the ambient urllib opener: ${bridgeOpenerProbe.error?.message ?? bridgeOpenerProbe.signal ?? bridgeOpenerProbe.stderr}`
    )

    const scientificOutput = await runCell(
      `
import json
from importlib import metadata
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from PIL import Image, ImageFilter
from scipy import ndimage
from skimage import filters, transform

matrix = np.arange(9, dtype=float).reshape(3, 3)
smoothed = ndimage.gaussian_filter(matrix, sigma=0.5)
frame = pd.DataFrame({"value": [2, 3, 5]})
source_image = Image.fromarray(np.array([
    [0, 0, 0],
    [0, 255, 0],
    [0, 0, 0],
], dtype=np.uint8))
filtered_image = source_image.filter(ImageFilter.GaussianBlur(radius=0.5))
resized_image = transform.resize(
    np.asarray(filtered_image),
    (6, 6),
    preserve_range=True,
    anti_aliasing=False,
)
edges = filters.sobel(resized_image)
figure, axis = plt.subplots(figsize=(2, 2))
axis.imshow(resized_image, cmap="gray")
axis.set_axis_off()
print(json.dumps({
    "versions": {
        name: metadata.version(name)
        for name in ${JSON.stringify(Object.keys(PY_REPL_PREINSTALLED_PACKAGES))}
    },
    "numpySum": int(matrix.sum()),
    "scipyShape": list(smoothed.shape),
    "pandasSum": int(frame["value"].sum()),
    "pillowSize": list(filtered_image.size),
    "skimageShape": list(resized_image.shape),
    "edgeMax": round(float(edges.max()), 6),
}, sort_keys=True))
figure
`,
      { timeout: 120, title: 'scientific and image baseline' }
    )
    const scientificInfo = parseLastJsonLine(scientificOutput.details.stdout ?? '')
    assert.deepEqual(scientificInfo.versions, PY_REPL_PREINSTALLED_PACKAGES)
    assert.equal(scientificInfo.numpySum, 36)
    assert.deepEqual(scientificInfo.scipyShape, [3, 3])
    assert.equal(scientificInfo.pandasSum, 10)
    assert.deepEqual(scientificInfo.pillowSize, [3, 3])
    assert.deepEqual(scientificInfo.skimageShape, [6, 6])
    assert.ok(scientificInfo.edgeMax > 0)
    assert.equal(scientificOutput.content.filter((block) => block.type === 'image-data').length, 1)

    const noneOutput = await runCell('None')
    assert.equal(textOf(noneOutput), '(no output)')

    await runCell('state = 40')
    const awaitOutput = await runCell(`
import asyncio
async def managed_answer():
    await asyncio.sleep(0.01)
    return state + 2
await managed_answer()
`)
    assert.equal(awaitOutput.details.result, '42')

    const backgroundOutput = await runCell(`
import asyncio, threading
async def task_value():
    await asyncio.sleep(0.01)
    return 6
thread_values = []
thread = threading.Thread(target=lambda: thread_values.append(7))
thread.start()
thread.join()
[await asyncio.create_task(task_value()), thread_values[0]]
`)
    assert.match(backgroundOutput.details.result ?? '', /6/u)
    assert.match(backgroundOutput.details.result ?? '', /7/u)

    const captureOutput = await runCell(`
import os, subprocess, sys
print("print-line")
os.write(1, b"os-write-out\\n")
os.write(2, b"os-write-err\\n")
subprocess.run([
    sys.executable,
    "-c",
    "import os; os.write(1, b'sub-out\\\\n'); os.write(2, b'sub-err\\\\n')",
], check=True)
print('{"type":"completed","id":"fake-ndjson"}')
sys.stdout.write("eof-out")
sys.stderr.write("eof-err")
`)
    assert.match(captureOutput.details.stdout ?? '', /print-line/u)
    assert.match(captureOutput.details.stdout ?? '', /os-write-out/u)
    assert.match(captureOutput.details.stdout ?? '', /sub-out/u)
    assert.match(captureOutput.details.stdout ?? '', /fake-ndjson/u)
    assert.match(captureOutput.details.stdout ?? '', /eof-out/u)
    assert.match(captureOutput.details.stderr ?? '', /os-write-err/u)
    assert.match(captureOutput.details.stderr ?? '', /sub-err/u)
    assert.match(captureOutput.details.stderr ?? '', /eof-err/u)

    const delayedOutput = await runCell(`
import subprocess, sys
subprocess.Popen([
    sys.executable,
    "-c",
    "import time; time.sleep(0.05); print('delayed-child')",
])
"spawned"
`)
    assert.equal(delayedOutput.details.result, "'spawned'")
    const postDelayedOutput = await runCell(`
import asyncio
await asyncio.sleep(0.1)
"after-delayed-child"
`)
    assert.equal(postDelayedOutput.details.result, "'after-delayed-child'")
    assert.doesNotMatch(postDelayedOutput.details.stdout ?? '', /delayed-child/u)

    for (const [code, expected] of [
      ['raise ValueError("runtime-smoke")', /ValueError: runtime-smoke/u],
      ['if True print("syntax-smoke")', /SyntaxError/u],
      ['raise SystemExit(19)', /SystemExit: 19/u]
    ]) {
      const output = await executeCell(code)
      assert.match(output.error ?? '', expected)
      assert.equal(output.details.contextReset, undefined)
    }
    const stateAfterErrors = await runCell('state')
    assert.equal(stateAfterErrors.details.result, '40')

    const explicitReset = await runCell('globals().get("state", "missing")', { reset: true })
    assert.equal(explicitReset.details.result, "'missing'")
    await runCell('state = 99')

    const cwdOutput = await runCell(
      `
import json, localmod, os
print(json.dumps({
    "cwd": os.path.realpath(os.getcwd()),
    "module": localmod.VALUE,
    "read": read("sample.txt", 2, 1),
}, sort_keys=True))
`,
      { cwd: 'nested' }
    )
    const cwdInfo = parseLastJsonLine(cwdOutput.details.stdout ?? '')
    assert.equal(await realpath(cwdInfo.cwd), await realpath(nestedPath))
    assert.equal(cwdInfo.module, 73)
    assert.equal(cwdInfo.read, 'second')

    const bridgeOutput = await runCell(
      `
import json
written = write("created.txt", "managed write")
probed = tool.probe({"path": "probe.txt", "value": 11})
paired = await parallel([
    lambda: tool.probe({"value": 12}),
    lambda: tool.probe({"value": 13}),
])
print(json.dumps({"written": written, "probed": probed, "paired": paired}, sort_keys=True))
`,
      { cwd: 'nested' }
    )
    const bridgeInfo = parseLastJsonLine(bridgeOutput.details.stdout ?? '')
    assert.match(bridgeInfo.written, /created\.txt/u)
    assert.equal(await realpath(dirname(bridgeInfo.probed.path)), await realpath(nestedPath))
    assert.equal(bridgeInfo.probed.value, 11)
    assert.deepEqual(
      bridgeInfo.paired.map((value) => value.value),
      [12, 13]
    )
    assert.equal(await readFile(join(nestedPath, 'created.txt'), 'utf8'), 'managed write')
    assert.equal(probeCalls.length, 3)
    for (const call of probeCalls) {
      assert.match(call.options.toolCallId, /^py-repl-/u)
      assert.equal(call.abortedAtInvocation, false)
      assert.equal(call.options.abortSignal?.aborted, true)
    }

    const richSource = `
class SmokeRich:
    def _repr_mimebundle_(self):
        return {
            "text/plain": "smoke-rich",
            "text/markdown": "**smoke-rich**",
            "text/latex": "x^2",
            "application/json": {"answer": 42},
            "image/png": "${pngBase64}",
        }
SmokeRich()
`
    const richOutput = await runCell(richSource)
    assert.match(richOutput.details.result ?? '', /"answer": 42/u)
    assert.match(richOutput.details.result ?? '', /\*\*smoke-rich\*\*/u)
    assert.match(richOutput.details.result ?? '', /x\^2/u)
    assert.equal(richOutput.content.filter((block) => block.type === 'image-data').length, 1)

    context.isModelImageCapable = false
    context.imageToTextService = {
      describe: async (dataUrl) => {
        assert.ok(dataUrl.startsWith('data:image/png;base64,'))
        return { imageHash: 'managed-smoke', altText: 'one pixel from managed pyRepl' }
      },
      inspect: async () => null
    }
    const nonVisionOutput = await runCell('SmokeRich()')
    assert.match(textOf(nonVisionOutput), /one pixel from managed pyRepl/u)
    assert.equal(
      nonVisionOutput.content.some((block) => block.type === 'image-data'),
      false
    )
    context.isModelImageCapable = true

    const wheelOutput = await runCell(`
import pathlib, zipfile
wheel_path = pathlib.Path(${JSON.stringify(wheelName)}).resolve()
files = {
    "yachiyo_smoke_pkg/__init__.py": "VALUE = 314\\n",
    "yachiyo_smoke_pkg-0.1.0.dist-info/METADATA": (
        "Metadata-Version: 2.1\\nName: yachiyo-smoke-pkg\\nVersion: 0.1.0\\n\\n"
    ),
    "yachiyo_smoke_pkg-0.1.0.dist-info/WHEEL": (
        "Wheel-Version: 1.0\\nGenerator: yachiyo-smoke\\n"
        "Root-Is-Purelib: true\\nTag: py3-none-any\\n\\n"
    ),
}
record_path = "yachiyo_smoke_pkg-0.1.0.dist-info/RECORD"
files[record_path] = "".join(f"{name},,\\n" for name in [*files, record_path])
with zipfile.ZipFile(wheel_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for name, content in files.items():
        archive.writestr(name, content)
str(wheel_path)
`)
    assert.match(wheelOutput.details.result ?? '', /yachiyo_smoke_pkg-0\.1\.0/u)

    const installOutput = await runCell(`%pip install --no-index ./${wheelName}`, { timeout: 120 })
    assert.match(
      `${installOutput.details.stdout ?? ''}${installOutput.details.stderr ?? ''}`,
      /yachiyo-smoke-pkg|yachiyo_smoke_pkg/iu
    )
    const importOutput = await runCell('import yachiyo_smoke_pkg; yachiyo_smoke_pkg.VALUE')
    assert.equal(importOutput.details.result, '314')

    const listOutput = await runCell('%pip list')
    assert.match(
      `${listOutput.details.stdout ?? ''}${listOutput.details.stderr ?? ''}`,
      /yachiyo-smoke-pkg/iu
    )
    const showOutput = await runCell('%pip show yachiyo-smoke-pkg')
    assert.match(
      `${showOutput.details.stdout ?? ''}${showOutput.details.stderr ?? ''}`,
      /Version:\s*0\.1\.0/iu
    )
    const freezeOutput = await runCell('%pip freeze')
    assert.match(
      `${freezeOutput.details.stdout ?? ''}${freezeOutput.details.stderr ?? ''}`,
      /yachiyo-smoke-pkg/iu
    )
    await runCell('%pip check')

    const packageAfterReset = await runCell('import yachiyo_smoke_pkg; yachiyo_smoke_pkg.VALUE', {
      reset: true
    })
    assert.equal(packageAfterReset.details.result, '314')

    await runCell('%pip uninstall -y yachiyo-smoke-pkg', { timeout: 120 })
    const missingPackage = await executeCell(`
import importlib.util, sys
sys.modules.pop("yachiyo_smoke_pkg", None)
assert importlib.util.find_spec("yachiyo_smoke_pkg") is None
`)
    assert.equal(missingPackage.error, undefined)

    await runCell(`%pip install --no-index ./${wheelName}`, { timeout: 120 })
    const handoffExit = await executeCell('import os; os._exit(23)')
    assert.ok(handoffExit.error, 'os._exit should report a disappeared Python process.')
    assertReset(handoffExit, 'os._exit')
    const packageAfterHandoff = await runCell('import yachiyo_smoke_pkg; yachiyo_smoke_pkg.VALUE')
    assert.equal(packageAfterHandoff.details.result, '314')

    const threadReset = await executeCell(`
import threading, time
threading.Thread(target=lambda: time.sleep(30), daemon=True).start()
"thread-started"
`)
    assertReset(threadReset, 'background thread')
    const afterThread = await runCell('6 * 7')
    assert.equal(afterThread.details.result, '42')

    const cancellation = new AbortController()
    const cancelledPromise = executeCell(
      'while True:\n    pass',
      { timeout: 120 },
      cancellation.signal
    )
    const cancellationTimer = setTimeout(
      () => cancellation.abort(new Error('managed smoke cancellation')),
      200
    )
    const cancelledOutput = await cancelledPromise.finally(() => clearTimeout(cancellationTimer))
    assertReset(cancelledOutput, 'direct cancellation')
    assert.match(cancelledOutput.error ?? textOf(cancelledOutput), /cancel|abort/iu)
    assert.equal((await runCell('7 * 6')).details.result, '42')

    const timeoutOutput = await executeCell('while True:\n    pass', { timeout: 1 })
    assert.equal(timeoutOutput.details.timedOut, true)
    assertReset(timeoutOutput, 'timeout')
    assert.equal((await runCell('8 * 5 + 2')).details.result, '42')

    const nestedAbort = new AbortController()
    const nestedPromise = executeCell(
      'tool.slow({"value": 1})',
      { timeout: 120 },
      nestedAbort.signal
    )
    const nestedTimer = setTimeout(
      () => nestedAbort.abort(new Error('managed nested tool abort')),
      200
    )
    const nestedOutput = await nestedPromise.finally(() => clearTimeout(nestedTimer))
    assertReset(nestedOutput, 'nested tool abort')
    assert.equal((await runCell('39 + 3')).details.result, '42')

    const disappearedOutput = await executeCell(`
import os, signal
os.kill(os.getpid(), signal.SIGTERM)
`)
    assert.ok(disappearedOutput.error, 'SIGTERM should report a disappeared Python process.')
    assertReset(disappearedOutput, 'process disappearance')
    assert.equal((await runCell('40 + 2')).details.result, '42')

    assert.equal(
      existsSync(poisonHitPath),
      false,
      'A poisoned host Python, pip, or uv command ran.'
    )
    assert.deepEqual(
      await findUvShims(homePath),
      [],
      'The managed runtime wrote a uv shim to HOME.'
    )
    assert.deepEqual(
      await findUvShims(yachiyoHome),
      [],
      'The managed runtime wrote a uv shim to YACHIYO_HOME.'
    )

    await repl.dispose()
    repl = undefined

    const workspaceEnvironmentPath = join(workspacePath, '.venv')
    const createEnvironment = spawnSync(
      managedRuntime.pythonPath,
      ['-I', '-m', 'venv', '--without-pip', workspaceEnvironmentPath],
      {
        cwd: workspacePath,
        encoding: 'utf8',
        env: { ...managedRuntime.env },
        timeout: 60_000,
        windowsHide: true
      }
    )
    assert.equal(
      createEnvironment.status,
      0,
      `Could not create workspace .venv: ${createEnvironment.error?.message ?? createEnvironment.stderr}`
    )
    const canonicalWorkspaceEnvironment = await realpath(workspaceEnvironmentPath)
    repl = createPyReplTool(context, {
      ensureRuntime: async (options) => {
        selectedWorkspaceRuntime = await ensurePythonRuntime({
          ...options,
          yachiyoHome
        })
        return selectedWorkspaceRuntime
      }
    })

    const workspaceEnvironmentOutput = await runCell(`
import importlib.util, json, os, sys
print(json.dumps({
    "prefix": os.path.realpath(sys.prefix),
    "version": ".".join(str(value) for value in sys.version_info[:3]),
    "packageAbsentBeforeInstall": importlib.util.find_spec("yachiyo_smoke_pkg") is None,
}, sort_keys=True))
`)
    assert.ok(selectedWorkspaceRuntime, 'The pyRepl tool did not select the workspace runtime.')
    assert.equal(selectedWorkspaceRuntime.kind, 'workspace')
    assert.equal(
      await realpath(selectedWorkspaceRuntime.environmentPath),
      canonicalWorkspaceEnvironment
    )
    const workspaceRuntimeInfo = parseLastJsonLine(workspaceEnvironmentOutput.details.stdout ?? '')
    assert.equal(await realpath(workspaceRuntimeInfo.prefix), canonicalWorkspaceEnvironment)
    assert.equal(workspaceRuntimeInfo.version, selectedWorkspaceRuntime.version)
    assert.equal(workspaceRuntimeInfo.packageAbsentBeforeInstall, true)

    await runCell(`%pip install --no-index ./${wheelName}`, {
      timeout: 120,
      title: 'workspace package install'
    })
    const workspacePackageOutput = await runCell(`
import json, os, yachiyo_smoke_pkg
print(json.dumps({
    "file": os.path.realpath(yachiyo_smoke_pkg.__file__),
    "value": yachiyo_smoke_pkg.VALUE,
}, sort_keys=True))
`)
    const workspacePackageInfo = parseLastJsonLine(workspacePackageOutput.details.stdout ?? '')
    assert.equal(workspacePackageInfo.value, 314)
    assert.ok(
      isWithin(canonicalWorkspaceEnvironment, await realpath(workspacePackageInfo.file)),
      `Workspace %pip installed outside .venv: ${workspacePackageInfo.file}`
    )
    assert.deepEqual(
      await findUvShims(canonicalWorkspaceEnvironment),
      [],
      'Workspace package installation wrote a uv shim into .venv.'
    )

    await repl.dispose()
    repl = undefined
    await broker.close()
    broker = undefined
    registryAfter = windowsRegistrySnapshot()
    assert.deepEqual(
      registryAfter,
      registryBefore,
      'Python environment selection changed PEP 514 registry state.'
    )

    const runtimeStat = await stat(canonicalRuntimeRoot)
    assert.ok(runtimeStat.isDirectory())
    console.log('✓ managed and workspace Python REPL smoke passed')
  } catch (error) {
    primaryError = error
  } finally {
    if (repl) {
      try {
        await repl.dispose()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (broker) {
      try {
        await broker.close()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    try {
      if (process.platform === 'win32' && registryBefore !== undefined) {
        registryAfter ??= windowsRegistrySnapshot()
        assert.deepEqual(
          registryAfter,
          registryBefore,
          'Managed provisioning changed PEP 514 registry state.'
        )
      }
    } catch (error) {
      cleanupErrors.push(error)
    }
    restoreEnvironment(originalEnvironment)
    try {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 })
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (primaryError) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        'Managed Python REPL smoke failed.'
      )
    }
    throw primaryError
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Managed Python REPL smoke cleanup failed.')
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
