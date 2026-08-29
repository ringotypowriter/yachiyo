/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @param {string} directory
 * @param {'native' | 'node'} basket
 * @returns {string[]}
 */
export function collectServerTestFiles(directory, basket) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(directory, entry.name)

    if (entry.isDirectory()) {
      return collectServerTestFiles(fullPath, basket)
    }

    if (!entry.isFile()) {
      return []
    }

    const isNativeTest = entry.name.endsWith('.native.test.ts')
    if (basket === 'native') {
      return isNativeTest ? [fullPath] : []
    }

    if (!entry.name.endsWith('.test.ts') || isNativeTest || entry.name.endsWith('.mac.test.ts')) {
      return []
    }

    return [fullPath]
  })
}
