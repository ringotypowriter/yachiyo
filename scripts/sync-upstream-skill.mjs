#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
/**
 * Sync a bundled core skill from an upstream GitHub repository.
 *
 * Usage:
 *   node scripts/sync-upstream-skill.mjs [--check]
 *
 * Flags:
 *   --check   Exit non-zero if local files differ from upstream (CI mode).
 *
 * Configuration lives in UPSTREAM_SKILLS below. To add a new upstream skill,
 * append an entry with { repo, remotePath, localDir }.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const UPSTREAM_SKILLS = [
  {
    repo: 'ringotypowriter/kagete',
    remotePath: 'skills/kagete',
    localDir: 'resources/core-skills/yachiyo-kagete'
  }
]

const checkOnly = process.argv.includes('--check')

async function latestTag(repo) {
  const url = `https://api.github.com/repos/${repo}/releases/latest`
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
    }
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`)
  const data = await res.json()
  return data.tag_name
}

async function downloadTree(repo, ref, remotePath) {
  const url = `https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
    }
  })
  if (!res.ok) throw new Error(`GitHub tree API ${res.status}: ${await res.text()}`)
  const data = await res.json()

  const prefix = remotePath.endsWith('/') ? remotePath : remotePath + '/'
  const files = data.tree.filter(
    (t) => t.type === 'blob' && (t.path === remotePath || t.path.startsWith(prefix))
  )

  const result = []
  for (const file of files) {
    const blobRes = await fetch(`https://api.github.com/repos/${repo}/git/blobs/${file.sha}`, {
      headers: {
        Accept: 'application/vnd.github.raw+json',
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
      }
    })
    if (!blobRes.ok) throw new Error(`Blob fetch failed: ${blobRes.status}`)
    const content = await blobRes.text()
    const relPath = file.path.startsWith(prefix)
      ? file.path.slice(prefix.length)
      : basename(file.path)
    result.push({ path: relPath, content })
  }
  return result
}

function readVersionFile(localDir) {
  const versionPath = join(ROOT, localDir, '.upstream-version')
  if (!existsSync(versionPath)) return null
  return readFileSync(versionPath, 'utf8').trim()
}

function writeVersionFile(localDir, tag) {
  writeFileSync(join(ROOT, localDir, '.upstream-version'), tag + '\n')
}

async function syncSkill({ repo, remotePath, localDir }) {
  const tag = await latestTag(repo)
  const currentVersion = readVersionFile(localDir)
  const skillName = basename(localDir)

  if (currentVersion === tag) {
    console.log(`✓ ${skillName} is up to date (${tag})`)
    return false
  }

  console.log(`${skillName}: ${currentVersion ?? '(none)'} → ${tag}`)

  const files = await downloadTree(repo, tag, remotePath)
  if (files.length === 0) {
    throw new Error(`No files found at ${remotePath} in ${repo}@${tag}`)
  }

  if (checkOnly) {
    let changed = false
    for (const file of files) {
      const localPath = join(ROOT, localDir, file.path)
      if (!existsSync(localPath)) {
        console.log(`  + ${file.path} (new)`)
        changed = true
        continue
      }
      const local = readFileSync(localPath, 'utf8')
      if (local !== file.content) {
        console.log(`  ~ ${file.path} (changed)`)
        changed = true
      }
    }
    if (changed) {
      console.log(
        `  ✗ ${skillName} is out of date (local: ${currentVersion ?? 'none'}, upstream: ${tag})`
      )
    }
    return changed
  }

  const destDir = join(ROOT, localDir)
  const keepFiles = new Set(['.upstream-version'])

  if (existsSync(destDir)) {
    const { readdirSync, statSync } = await import('node:fs')
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        if (keepFiles.has(entry) && dir === destDir) continue
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          walk(full)
          rmSync(full, { recursive: true, force: true })
        } else {
          rmSync(full, { force: true })
        }
      }
    }
    walk(destDir)
  }

  for (const file of files) {
    const filePath = join(destDir, file.path)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, file.content)
  }

  writeVersionFile(localDir, tag)
  console.log(`  ✓ synced ${files.length} files from ${repo}@${tag}`)
  return true
}

let anyChanged = false
for (const skill of UPSTREAM_SKILLS) {
  try {
    const changed = await syncSkill(skill)
    if (changed) anyChanged = true
  } catch (err) {
    console.error(`✗ ${skill.repo}: ${err.message}`)
    process.exit(1)
  }
}

if (checkOnly && anyChanged) {
  console.log('\nUpstream skills are out of date. Run: node scripts/sync-upstream-skill.mjs')
  process.exit(1)
}
