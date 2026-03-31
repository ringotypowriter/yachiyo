import type { MessageRecord } from './protocol'

export interface MessageTreeNode {
  id: string
  parentMessageId?: string
  createdAt: string
}

export interface MessageTreeMaps<T extends MessageTreeNode> {
  byId: Map<string, T>
  childrenByParent: Map<string | null, T[]>
}

function compareByCreatedAt<T extends { createdAt: string }>(left: T, right: T): number {
  return left.createdAt.localeCompare(right.createdAt)
}

export function sortMessagesByCreatedAt<T extends { createdAt: string }>(messages: T[]): T[] {
  return [...messages].sort(compareByCreatedAt)
}

export function buildMessageTreeMaps<T extends MessageTreeNode>(messages: T[]): MessageTreeMaps<T> {
  const byId = new Map(messages.map((message) => [message.id, message]))
  const childrenByParent = new Map<string | null, T[]>()

  for (const message of sortMessagesByCreatedAt(messages)) {
    const parentKey = message.parentMessageId ?? null
    const children = childrenByParent.get(parentKey) ?? []
    children.push(message)
    childrenByParent.set(parentKey, children)
  }

  return { byId, childrenByParent }
}

export function collectMessagePath<T extends MessageTreeNode>(
  messages: T[],
  targetMessageId: string
): T[] {
  return collectMessagePathFromMaps(buildMessageTreeMaps(messages), targetMessageId)
}

export function collectMessagePathFromMaps<T extends MessageTreeNode>(
  maps: MessageTreeMaps<T>,
  targetMessageId: string
): T[] {
  const path: T[] = []
  const visited = new Set<string>()
  let currentId: string | undefined = targetMessageId

  while (currentId) {
    if (visited.has(currentId)) {
      break
    }
    const current = maps.byId.get(currentId)
    if (!current) {
      break
    }

    visited.add(currentId)
    path.push(current)
    currentId = current.parentMessageId
  }

  return path.reverse()
}

export function collectDescendantIds<T extends MessageTreeNode>(
  messages: T[],
  rootMessageId: string
): Set<string> {
  const maps = buildMessageTreeMaps(messages)
  const descendantIds = new Set<string>()
  const stack = [rootMessageId]

  while (stack.length > 0) {
    const nextId = stack.pop()
    if (!nextId || descendantIds.has(nextId)) {
      continue
    }

    descendantIds.add(nextId)

    for (const child of maps.childrenByParent.get(nextId) ?? []) {
      stack.push(child.id)
    }
  }

  return descendantIds
}

export function wouldCreateParentCycle<T extends MessageTreeNode>(
  messages: T[],
  messageId: string,
  parentMessageId: string | undefined
): boolean {
  if (!parentMessageId) {
    return false
  }

  if (messageId === parentMessageId) {
    return true
  }

  return collectMessagePath(messages, parentMessageId).some((message) => message.id === messageId)
}

function findLatestLeafFromMaps<T extends MessageTreeNode>(
  maps: MessageTreeMaps<T>,
  rootMessageId: string
): T | undefined {
  const root = maps.byId.get(rootMessageId)
  if (!root) {
    return undefined
  }

  let latestLeaf = root
  const stack = [root]
  const visited = new Set<string>()

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || visited.has(current.id)) {
      continue
    }

    visited.add(current.id)
    const children = maps.childrenByParent.get(current.id) ?? []
    if (children.length === 0) {
      if (current.createdAt.localeCompare(latestLeaf.createdAt) >= 0) {
        latestLeaf = current
      }
      continue
    }

    for (const child of children) {
      stack.push(child)
    }
  }

  return latestLeaf
}

export function pickLatestLeafId<T extends MessageTreeNode>(
  messages: T[],
  rootMessageId: string
): string | undefined {
  return findLatestLeafFromMaps(buildMessageTreeMaps(messages), rootMessageId)?.id
}

export function pickReplacementHeadId(
  originalMessages: MessageRecord[],
  remainingMessages: MessageRecord[],
  previousHeadMessageId?: string
): string | undefined {
  if (
    previousHeadMessageId &&
    remainingMessages.some((message) => message.id === previousHeadMessageId)
  ) {
    return previousHeadMessageId
  }

  const originalMaps = buildMessageTreeMaps(originalMessages)
  const remainingMaps = buildMessageTreeMaps(remainingMessages)
  const visitedAncestors = new Set<string>()

  let ancestorId = previousHeadMessageId
    ? originalMaps.byId.get(previousHeadMessageId)?.parentMessageId
    : undefined

  while (ancestorId) {
    if (visitedAncestors.has(ancestorId)) {
      break
    }

    visitedAncestors.add(ancestorId)
    if (remainingMaps.byId.has(ancestorId)) {
      return findLatestLeafFromMaps(remainingMaps, ancestorId)?.id ?? ancestorId
    }

    ancestorId = originalMaps.byId.get(ancestorId)?.parentMessageId
  }

  const latestRootLeaf = [...(remainingMaps.childrenByParent.get(null) ?? [])]
    .map((root) => findLatestLeafFromMaps(remainingMaps, root.id) ?? root)
    .sort(compareByCreatedAt)
    .at(-1)

  return latestRootLeaf?.id
}
