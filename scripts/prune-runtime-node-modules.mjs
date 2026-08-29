/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'

function removePath(nodeModulesDir, path, removedPaths) {
  if (!existsSync(path)) return
  rmSync(path, { recursive: true, force: true })
  removedPaths.push(relative(nodeModulesDir, path))
}

function compactNativeBuild(nodeModulesDir, packageRoot, artifactName, report) {
  if (!existsSync(packageRoot)) return

  const buildDir = join(packageRoot, 'build')
  const artifactPath = join(buildDir, 'Release', artifactName)
  if (!existsSync(artifactPath)) {
    throw new Error(`Cannot prune ${packageRoot}: rebuilt artifact ${artifactPath} is missing.`)
  }

  const temporaryArtifact = join(packageRoot, `.${artifactName}.runtime`)
  rmSync(temporaryArtifact, { force: true })
  copyFileSync(artifactPath, temporaryArtifact)
  rmSync(buildDir, { recursive: true, force: true })
  mkdirSync(join(buildDir, 'Release'), { recursive: true })
  renameSync(temporaryArtifact, artifactPath)
  report.compactedNativeBuilds.push(relative(nodeModulesDir, artifactPath))
}

function pruneForeignPrebuilds(nodeModulesDir, packageRoot, platform, arch, removedPaths) {
  const prebuildsDir = join(packageRoot, 'prebuilds')
  const currentTarget = `${platform}-${arch}`
  if (!existsSync(join(prebuildsDir, currentTarget))) return

  for (const entry of readdirSync(prebuildsDir, { withFileTypes: true })) {
    if (entry.name === currentTarget) continue
    removePath(nodeModulesDir, join(prebuildsDir, entry.name), removedPaths)
  }
}

export function pruneStagedRuntimeNodeModules(
  nodeModulesDir,
  { platform = process.platform, arch = process.arch } = {}
) {
  const report = { removedPaths: [], compactedNativeBuilds: [] }
  const betterSqliteRoot = join(nodeModulesDir, 'better-sqlite3')
  const zlibSyncRoot = join(nodeModulesDir, 'zlib-sync')
  const dominoRoot = join(nodeModulesDir, '@mixmark-io', 'domino')

  compactNativeBuild(nodeModulesDir, betterSqliteRoot, 'better_sqlite3.node', report)
  for (const path of ['binding.gyp', 'deps', 'src', 'README.md']) {
    removePath(nodeModulesDir, join(betterSqliteRoot, path), report.removedPaths)
  }

  compactNativeBuild(nodeModulesDir, zlibSyncRoot, 'zlib_sync.node', report)
  for (const path of ['binding.gyp', 'bin', 'deps', 'src', 'README.md']) {
    removePath(nodeModulesDir, join(zlibSyncRoot, path), report.removedPaths)
  }

  for (const path of [
    '.gitmodules',
    '.mocharc.json',
    '.nvmrc',
    '.yarn',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'README.md',
    'test'
  ]) {
    removePath(nodeModulesDir, join(dominoRoot, path), report.removedPaths)
  }

  for (const packageName of ['bufferutil', 'utf-8-validate']) {
    pruneForeignPrebuilds(
      nodeModulesDir,
      join(nodeModulesDir, packageName),
      platform,
      arch,
      report.removedPaths
    )
  }

  report.removedPaths.sort()
  report.compactedNativeBuilds.sort()
  return report
}
