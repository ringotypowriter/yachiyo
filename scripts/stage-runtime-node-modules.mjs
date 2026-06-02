#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { builtinModules, createRequire } from 'node:module'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appDir = resolve(repoRoot, 'apps', 'desktop')
const outMainDir = resolve(appDir, 'out', 'main')
const stagedRuntimeDir = resolve(appDir, 'out', 'runtime-node-modules')
const stagedNodeModulesDir = join(stagedRuntimeDir, 'node_modules')
const packageSearchRoots = [
  appDir,
  resolve(repoRoot, 'packages', 'runtime'),
  resolve(repoRoot, 'packages', 'cli'),
  repoRoot
]
const explicitRuntimePackages = new Map([['better-sqlite3', ['native SQLite runtime package']]])
const optionalRuntimePackages = new Set(['bufferutil', 'utf-8-validate', 'zlib-sync'])
const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  'electron'
])
const requirePattern = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/gu

function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || builtins.has(specifier)) {
    return undefined
  }

  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/')
    return scope && name ? `${scope}/${name}` : undefined
  }

  return specifier.split('/')[0]
}

function packagePath(root, packageName) {
  return join(root, 'node_modules', ...packageName.split('/'))
}

function packageJsonPath(packageRoot) {
  return join(packageRoot, 'package.json')
}

function resolvePackageRoot(packageName, searchRoots) {
  for (const root of searchRoots) {
    const candidate = packagePath(root, packageName)
    if (existsSync(packageJsonPath(candidate))) {
      return realpathSync(candidate)
    }
  }

  try {
    const entry = require.resolve(packageName, { paths: searchRoots })
    let current = dirname(entry)
    while (current !== dirname(current)) {
      if (existsSync(packageJsonPath(current))) {
        return realpathSync(current)
      }
      current = dirname(current)
    }
  } catch {
    // Handled by caller.
  }

  return undefined
}

function readPackage(packageRoot) {
  return JSON.parse(readFileSync(packageJsonPath(packageRoot), 'utf8'))
}

function walkJavaScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') {
        return []
      }
      return walkJavaScriptFiles(fullPath)
    }

    return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : []
  })
}

function findRuntimeRequires() {
  const packages = new Map(
    [...explicitRuntimePackages].map(([packageName, reasons]) => [packageName, [...reasons]])
  )
  for (const file of walkJavaScriptFiles(outMainDir)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(requirePattern)) {
      const packageName = packageNameFromSpecifier(match[1])
      if (!packageName) {
        continue
      }
      const reasons = packages.get(packageName) ?? []
      reasons.push(`${file.slice(repoRoot.length + 1)} -> ${match[1]}`)
      packages.set(packageName, reasons)
    }
  }
  return packages
}

function copyPackage(packageName, packageRoot) {
  const destination = join(stagedNodeModulesDir, ...packageName.split('/'))
  const nestedNodeModules = join(packageRoot, 'node_modules')

  rmSync(destination, { recursive: true, force: true })
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(packageRoot, destination, {
    recursive: true,
    dereference: true,
    filter(source) {
      return source !== nestedNodeModules && !source.startsWith(`${nestedNodeModules}${sep}`)
    }
  })
}

function packageExists(packageName, searchRoots) {
  return Boolean(resolvePackageRoot(packageName, searchRoots))
}

function stageRuntimePackages(runtimeRequires) {
  const queue = [...runtimeRequires.keys()].map((packageName) => ({
    packageName,
    required: !optionalRuntimePackages.has(packageName),
    searchRoots: packageSearchRoots,
    reason: runtimeRequires.get(packageName)?.[0] ?? 'runtime require'
  }))
  const staged = new Map()
  const skippedOptional = []
  const missingRequired = []

  while (queue.length > 0) {
    const item = queue.shift()
    if (!item || staged.has(item.packageName)) {
      continue
    }

    const packageRoot = resolvePackageRoot(item.packageName, item.searchRoots)
    if (!packageRoot) {
      if (item.required) {
        missingRequired.push(`${item.packageName} (${item.reason})`)
      } else {
        skippedOptional.push(item.packageName)
      }
      continue
    }

    const manifest = readPackage(packageRoot)
    copyPackage(item.packageName, packageRoot)
    staged.set(item.packageName, packageRoot)

    const dependencySearchRoots = [packageRoot, ...packageSearchRoots]
    for (const dependencyName of Object.keys(manifest.dependencies ?? {})) {
      queue.push({
        packageName: dependencyName,
        required: true,
        searchRoots: dependencySearchRoots,
        reason: `${item.packageName} dependency`
      })
    }

    for (const dependencyName of Object.keys(manifest.optionalDependencies ?? {})) {
      queue.push({
        packageName: dependencyName,
        required: packageExists(dependencyName, dependencySearchRoots),
        searchRoots: dependencySearchRoots,
        reason: `${item.packageName} optional dependency`
      })
    }
  }

  if (missingRequired.length > 0) {
    console.error('Missing required runtime packages for packaged Electron output:')
    for (const entry of missingRequired) {
      console.error(`- ${entry}`)
    }
    process.exit(1)
  }

  return { staged, skippedOptional }
}

if (!existsSync(outMainDir) || !statSync(outMainDir).isDirectory()) {
  console.error(`Cannot stage runtime node_modules because ${outMainDir} does not exist.`)
  process.exit(1)
}

rmSync(stagedNodeModulesDir, { recursive: true, force: true })
mkdirSync(stagedNodeModulesDir, { recursive: true })

const runtimeRequires = findRuntimeRequires()
const { staged, skippedOptional } = stageRuntimePackages(runtimeRequires)
const manifestPath = join(stagedRuntimeDir, 'runtime-node-modules.json')
writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      packages: [...staged.keys()].sort(),
      skippedOptional: [...new Set(skippedOptional)].sort()
    },
    null,
    2
  )}\n`
)

console.log(`staged ${staged.size} runtime packages in ${stagedNodeModulesDir}`)
if (skippedOptional.length > 0) {
  console.log(
    `skipped optional runtime packages: ${[...new Set(skippedOptional)].sort().join(', ')}`
  )
}
