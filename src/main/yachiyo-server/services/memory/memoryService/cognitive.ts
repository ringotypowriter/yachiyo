import type { MessageRecord } from '../../../../../shared/yachiyo/protocol.ts'
import type { ModelMessage } from '../../../runtime/models/types.ts'
import {
  parseCognitivePatch,
  renderCognitiveRowMemoryEntry,
  type CognitiveEvidenceRef,
  type CognitiveMemoryState,
  type CognitivePatch
} from '../cognitiveMemory.ts'
import type { CognitiveMemoryStore } from '../cognitiveMemoryStore.ts'
import { filterByImportance, normalizeWhitespace, parseMemoryCandidates } from './parsing.ts'
import type {
  MemorySearchResult,
  MemoryScopeLevel,
  MemoryUnitType,
  StructuredMemoryCandidate
} from '../memoryService.ts'

export function mapUnitTypeToRelation(unitType: MemoryUnitType): string {
  const map: Record<MemoryUnitType, string> = {
    fact: 'known_facts',
    preference: 'user_preferences',
    decision: 'key_decisions',
    plan: 'active_plans',
    procedure: 'workflow_procedures',
    learning: 'lessons_learned',
    context: 'project_context',
    event: 'notable_events'
  }
  return map[unitType] ?? 'known_facts'
}

export function buildScopeFromLevel(
  level: MemoryScopeLevel | undefined,
  context: { threadId?: string; workspacePath?: string }
): Record<string, string> | undefined {
  if (!level || level === 'global') return undefined
  if (level === 'workspace' && context.workspacePath) {
    return { workspacePath: context.workspacePath }
  }
  if (level === 'thread' && context.threadId) {
    return { threadId: context.threadId }
  }
  return undefined
}

export function buildCandidatePatch(
  candidate: StructuredMemoryCandidate,
  evidence: CognitiveEvidenceRef[],
  scopeContext?: { threadId?: string; workspacePath?: string }
): CognitivePatch {
  const relation = mapUnitTypeToRelation(candidate.unitType)
  const scope = buildScopeFromLevel(candidate.scope, scopeContext ?? {})
  const confidence = candidate.importance ?? 0.5

  return {
    operations: [
      {
        type: 'upsertRelation',
        relation,
        purpose: `Durable ${candidate.unitType} entries remembered by Yachiyo.`,
        columns: Object.keys(candidate.facts),
        evidence
      },
      {
        type: 'upsertRow',
        relation,
        key: candidate.key,
        values: candidate.facts,
        subjects: candidate.subjects,
        aliases: candidate.subjects.slice(0, 3),
        triggers: candidate.subjects,
        confidence,
        ...(scope ? { scope } : {}),
        evidence
      }
    ]
  }
}

export function mergePatches(patches: CognitivePatch[]): CognitivePatch {
  return { operations: patches.flatMap((patch) => patch.operations) }
}

export function buildCognitiveStateExcerpt(state: CognitiveMemoryState): string {
  const relations = state.relations.slice(0, 12).map((relation) => ({
    name: relation.name,
    purpose: relation.purpose,
    columns: relation.columns.map((column) => column.name),
    rows: state.rows
      .filter((row) => row.relation === relation.name && row.status === 'active')
      .slice(0, 6)
      .map((row) => ({
        key: row.key,
        values: row.values,
        confidence: row.confidence,
        subjects: row.subjects,
        aliases: row.aliases,
        triggers: row.triggers,
        scope: row.scope
      }))
  }))
  return JSON.stringify({ relations }, null, 2)
}

export function buildCognitivePatchSystemPrompt(): string {
  return [
    "You maintain Yachiyo's cognitive memory: a relational knowledge graph that persists durable facts, preferences, decisions, plans, procedures, and lessons across sessions.",
    '',
    '## How cognitive paths work',
    '',
    'Relations are cognitive frames — stable tables that group similar durable knowledge.',
    'Rows are individual durable cognitions within a frame.',
    'Together they form a "cognitive path": when the user mentions a topic, relevant rows activate through their subjects, aliases, and triggers, bringing the right context back into future sessions.',
    '',
    '## Operations',
    '',
    '- upsertRelation: create or evolve a cognitive frame. Define its purpose and columns clearly.',
    '- upsertRow: add or update durable cognition. Use stable row keys. Populate subjects, aliases, and triggers generously so future recall is deterministic.',
    '- deprecateRow: mark outdated cognition as deprecated when new information contradicts it.',
    '',
    '## Design rules',
    '',
    '1. Relation design: prefer semantic frames over dumping everything into one table. For example, separate "project_architecture" from "user_preferences" from "workflow_procedures".',
    '2. Row keys: use stable, canonical identifiers. A key should still make sense six months from now. Use snake_case.',
    '3. Values: keep fields compact and factual. One row should capture one durable insight, not a transcript summary.',
    '4. Activation surface (critical): subjects, aliases, and triggers are how future queries find this row. Include natural language variants, domain terms, and likely user phrasings. Think: what words would the user actually type or say to surface this?',
    '5. Scope: use workspacePath or threadId when a cognition is tightly bound to a specific project or thread. Omit when broadly applicable.',
    '6. Confidence: 0.8–1.0 for major decisions or durable facts, 0.5–0.7 for useful patterns, 0.3–0.4 for minor notes.',
    '7. Evidence: every operation must include evidence. If exact source IDs are unknown, leave evidence empty and the runtime will fill it in.',
    '',
    '## Content rules',
    '',
    '- Rows are durable cognition, not summaries of this chat.',
    '- Do not use phrases like "this time", "just now", "currently", "we discussed", "it seems", or "maybe".',
    '- Do not write conversational summaries like "the user asked", "we talked about", or "the assistant said".',
    '- When the memory is about the user, prefer "<username> + objective description" if the username is explicitly known from context.',
    '- If the username is not explicitly known, omit the subject instead of writing "the user" or other chat-role labels.',
    '- If nothing durable changed, return {"operations":[]}.',
    '',
    '## Examples',
    '',
    'Bad relation design: one giant table "memories" with a single "content" column.',
    'Good relation design: "coding_agent_roles" with columns [agent, role, handoff_rule]; "user_preferences" with columns [topic, preference, rationale].',
    '',
    'Bad row key: "postgres-choice-march-2026" (dated, event-bound).',
    'Good row key: "database_choice" (stable, conceptual).',
    '',
    'Bad activation surface: subjects ["db"], triggers ["postgres"].',
    'Good activation surface: subjects ["database","PostgreSQL","SQL"], aliases ["db choice","postgres decision"], triggers ["ACID requirements","transaction safety","relational database"].',
    '',
    'Bad values: { "note": "the user mentioned this time that they prefer dark mode" }.',
    'Good values: { "preference": "prefers dark mode UI", "scope": "all Yachiyo interfaces" }.',
    '',
    '## Output format',
    '',
    'Return JSON only.',
    'Schema: {"operations":[{"type":"upsertRelation","relation":"snake_case","purpose":"string","columns":[{"name":"snake_case","description":"string"}],"evidence":[]},{"type":"upsertRow","relation":"snake_case","key":"stable_row_key","values":{"field":"value"},"subjects":["string"],"aliases":["string"],"triggers":["string"],"scope":{"workspacePath":"string"},"confidence":0.0,"evidence":[]},{"type":"deprecateRow","relation":"snake_case","key":"stable_row_key","reason":"string","evidence":[]}]}'
  ].join('\n')
}

export function buildRunCognitivePatchMessages(input: {
  assistantResponse: string
  state: CognitiveMemoryState
  userQuery: string
}): ModelMessage[] {
  return [
    { role: 'system', content: buildCognitivePatchSystemPrompt() },
    {
      role: 'user',
      content: [
        `Existing cognitive memory:\n${buildCognitiveStateExcerpt(input.state)}`,
        '',
        `User query:\n${input.userQuery}`,
        '',
        `Assistant response:\n${input.assistantResponse}`
      ].join('\n')
    }
  ]
}

export function buildSaveThreadCognitivePatchMessages(input: {
  messages: MessageRecord[]
  state: CognitiveMemoryState
}): ModelMessage[] {
  const transcript = input.messages
    .map((message) => `[${message.role}] ${normalizeWhitespace(message.content)}`)
    .join('\n')

  return [
    { role: 'system', content: buildCognitivePatchSystemPrompt() },
    {
      role: 'user',
      content: [
        `Existing cognitive memory:\n${buildCognitiveStateExcerpt(input.state)}`,
        '',
        `Conversation transcript:\n${transcript}`
      ].join('\n')
    }
  ]
}

export function parsePatchOrCandidateFallback(
  text: string,
  evidence: CognitiveEvidenceRef[]
): CognitivePatch {
  const patch = parseCognitivePatch(text, evidence)
  if (patch.operations.length > 0) return patch
  return mergePatches(
    filterByImportance(parseMemoryCandidates(text)).map((item) =>
      buildCandidatePatch(
        {
          key: item.topic,
          facts: {
            topic: item.topic,
            title: item.title,
            content: item.content,
            unit_type: item.unitType,
            importance: String(item.importance ?? 0.5)
          },
          subjects: [item.topic, item.title],
          unitType: item.unitType,
          importance: item.importance
        },
        evidence
      )
    )
  )
}

export function toCognitiveSearchResult(
  row: Awaited<ReturnType<CognitiveMemoryStore['searchRows']>>[number]
): MemorySearchResult {
  return {
    id: row.id,
    title: row.key,
    content: renderCognitiveRowMemoryEntry(row),
    labels: [`topic:${row.relation}`],
    importance: row.confidence,
    unitType: 'context'
  }
}
