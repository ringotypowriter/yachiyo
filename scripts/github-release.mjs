#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync, spawnSync } from 'node:child_process'
import process from 'node:process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const sections = [
  ['feat', 'Features'],
  ['fix', 'Bug Fixes'],
  ['refactor', 'Refactors']
]

function parseSubject(subject) {
  const match = /^(feat|fix|refactor)(?:\([^\r\n)]+\))?!?:\s+(.+)$/u.exec(subject)
  if (!match) return undefined
  return { type: match[1], description: match[2] }
}

export function renderReleaseNotes(input) {
  const grouped = new Map(sections.map(([type]) => [type, []]))

  for (const commit of input.commits) {
    const parsed = parseSubject(commit.subject)
    if (!parsed) continue
    grouped.get(parsed.type).push(`- ${parsed.description} (${commit.hash})`)
  }

  const rendered = []
  for (const [type, heading] of sections) {
    const entries = grouped.get(type)
    if (entries.length > 0) rendered.push(`## ${heading}\n${entries.join('\n')}`)
  }
  if (rendered.length > 0) return `${rendered.join('\n\n')}\n`

  if (!input.previousTag) return 'Initial release.\n'
  return `Maintenance release — see [commit history](https://github.com/${input.repository}/compare/${input.previousTag}...${input.tag}) for details.\n`
}

function readTags() {
  return execFileSync('git', ['tag', '--sort=v:refname'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
}

function findPreviousStableTag(tags, tag, target) {
  const stableTags = tags.filter((candidate) => !candidate.includes('beta'))
  if (target === tag) {
    const index = stableTags.indexOf(tag)
    if (index < 0) throw new Error(`Cannot find local release tag ${tag}`)
    return index > 0 ? stableTags[index - 1] : undefined
  }
  return stableTags.at(-1)
}

function readCommits(range) {
  const output = execFileSync('git', ['log', range, '--no-merges', '--format=%h%x00%s'], {
    encoding: 'utf8'
  })
  if (!output) return []

  return output
    .trimEnd()
    .split('\n')
    .map((line) => {
      const separator = line.indexOf('\0')
      if (separator < 0) throw new Error('Unexpected git log output')
      return {
        hash: line.slice(0, separator),
        subject: line.slice(separator + 1)
      }
    })
}

function parseArgs(args) {
  const options = {
    prerelease: false,
    repository: process.env.GITHUB_REPOSITORY
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--prerelease') {
      options.prerelease = true
      continue
    }
    if (argument === '--tag' || argument === '--target' || argument === '--repository') {
      const value = args[index + 1]
      if (!value) throw new Error(`${argument} requires a value`)
      options[argument.slice(2)] = value
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }

  if (!options.tag) throw new Error('--tag is required')
  if (!options.repository) throw new Error('--repository or GITHUB_REPOSITORY is required')
  options.target ??= options.tag
  return options
}

function runGh(args, notes) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    input: notes,
    stdio: ['pipe', 'inherit', 'inherit']
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`gh ${args.join(' ')} failed with status ${result.status}`)
}

export function prepareGithubRelease(options) {
  const tags = readTags()
  const previousTag = findPreviousStableTag(tags, options.tag, options.target)
  const range = previousTag ? `${previousTag}..${options.target}` : options.target
  const notes = renderReleaseNotes({
    commits: readCommits(range),
    previousTag,
    repository: options.repository,
    tag: options.tag
  })

  const view = spawnSync('gh', ['release', 'view', options.tag], { stdio: 'ignore' })
  if (view.error) throw view.error

  if (view.status === 0) {
    const args = ['release', 'edit', options.tag]
    if (options.prerelease) args.push('--prerelease')
    args.push('--title', options.tag, '--notes-file', '-')
    runGh(args, notes)
    return
  }

  const args = ['release', 'create', options.tag]
  if (options.target === options.tag) args.push('--verify-tag')
  else args.push('--target', options.target)
  if (options.prerelease) args.push('--prerelease')
  args.push('--title', options.tag, '--notes-file', '-')
  runGh(args, notes)
}

function main() {
  prepareGithubRelease(parseArgs(process.argv.slice(2)))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
}
