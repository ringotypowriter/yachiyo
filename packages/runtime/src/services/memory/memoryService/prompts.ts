import type { MessageRecord } from '@yachiyo/shared/protocol'
import type { ModelMessage } from '../../../runtime/models/types.ts'
import { normalizeWhitespace, sanitizeMemoryQueryText } from './parsing.ts'

const HISTORY_EXCERPT_PER_MESSAGE_CHARS = 400

export function buildHistoryExcerpt(history: MessageRecord[]): string {
  return history
    .slice(-4)
    .map((message) => {
      const clean = sanitizeMemoryQueryText(message.content, HISTORY_EXCERPT_PER_MESSAGE_CHARS)
      return `[${message.role}] ${clean}`
    })
    .join('\n')
}

export function buildQueryPlanningMessages(input: {
  history: MessageRecord[]
  isExternalChannel?: boolean
  userQuery: string
}): ModelMessage[] {
  const systemLines = input.isExternalChannel
    ? [
        'You create retrieval plans for long-term memory recall in a casual conversation context.',
        'Return JSON only.',
        'Schema: {"skip":true,"skipReason":"string"} or {"queries":[{"topic":"string","query":"string","reason":"string","weight":0.0}]}',
        'Set skip=true when the user is asking a general question, making small talk, or discussing something that clearly does not relate to any personal memory (interests, preferences, communication style, relationship context, or things they have shared about themselves).',
        'When skip=true, provide a concise skipReason.',
        'When skip=false, produce 0-2 focused semantic queries.',
        'Each topic must be a short stable canonical topic key, not a sentence.',
        'Target personal memories: who the user is, their interests, preferences, communication style, relationship context, and things they have shared about themselves.',
        'Do NOT search for project tasks, code decisions, technical workflows, bugs, or workspace-specific facts.',
        'Do NOT search for anything related to software development work unless the user is explicitly discussing it.',
        'Favor queries about the person, not about their work output.',
        'Avoid time words, temporary status, and conversational framing like "this time", "currently", "we discussed", or "maybe".',
        'Do not do naive keyword splitting.'
      ]
    : [
        'You create retrieval plans for long-term memory recall.',
        'Return JSON only.',
        'Schema: {"skip":true,"skipReason":"string"} or {"queries":[{"topic":"string","query":"string","reason":"string","weight":0.0}]}',
        'Set skip=true when the user is asking a general question, making small talk, or discussing something that clearly does not relate to any durable memory (preferences, decisions, workflows, constraints, bugs, or project facts).',
        'When skip=true, provide a concise skipReason.',
        'When skip=false, produce 0-3 focused semantic queries.',
        'Each topic must be a short stable canonical topic key, not a sentence.',
        'Each query must target durable memories such as preferences, decisions, workflows, constraints, bugs, project facts, and reusable troubleshooting knowledge.',
        'Write retrieval-oriented semantic queries, not naive keyword splitting and not paraphrases of the full user turn.',
        'Favor stable project wording that could match long-term memory written on earlier days.',
        'Prefer queries that can surface durable preferences, decisions, workflows, constraints, bugs, and project facts.',
        'Avoid time words, temporary status, and conversational framing like "this time", "currently", "we discussed", or "maybe".',
        'Do not do naive keyword splitting.',
        'Do not include run-specific chatter, filler, or temporary status language.'
      ]

  return [
    { role: 'system', content: systemLines.join('\n') },
    {
      role: 'user',
      content: [
        `Current user query:\n${input.userQuery}`,
        '',
        input.history.length > 0
          ? `Recent thread context:\n${buildHistoryExcerpt(input.history)}`
          : 'Recent thread context:\n(none)'
      ].join('\n')
    }
  ]
}

export function buildRunDistillationMessages(input: {
  assistantResponse: string
  userQuery: string
}): ModelMessage[] {
  return [
    {
      role: 'system',
      content: [
        'Extract durable long-term memory candidates from a completed exchange.',
        'Return JSON only.',
        'Schema: {"candidates":[{"topic":"string","title":"string","content":"string","unitType":"fact|preference|decision|plan|procedure|learning|context|event","importance":0.0}]}',
        'If no durable long-term knowledge is present, return {"candidates":[]}. Do not invent weak observations to fill the array.',
        'Only keep durable preferences, decisions, workflows, stable facts, or reusable lessons.',
        'Emit at most one candidate per durable topic.',
        'Topic must be a stable canonical topic identifier for dedupe and later updates.',
        'Title must be short, stable, canonical, topic-like, and noun-style when possible.',
        'Reuse the same topic key and title for repeated long-term topics instead of inventing variants.',
        'Content must be normalized durable wording, compact, factual, and easy to compare during future updates.',
        'When the memory is about the user, prefer "<username> + objective description" if the username is explicitly known from context.',
        'If the username is not explicitly known, omit the subject instead of writing "the user" or other chat-role labels.',
        'Content must not describe the chat itself, the thread itself, or the current run.',
        'Exclude temporary run chatter, conversational filler, and weak observations.',
        'Do not use phrases like "this time", "just now", "currently", "we discussed", "it seems", or "maybe".',
        'Do not write vague conversational summaries like "the user asked", "we talked about", or "the assistant said".',
        'Do not emit multiple near-duplicate candidates for the same long-term topic.',
        'Examples:',
        'Bad: "the user prefers concise status updates."',
        'Good: "<username> prefers concise status updates."',
        'Bad: "we discussed using the repo root for commands."',
        'Good: "<username> uses the Yachiyo repo root for commands."',
        'Bad: "this time the user mentioned disliking bureaucratic language."',
        'Good: "<username> dislikes bureaucratic or overly formal language."'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        `User query:\n${input.userQuery}`,
        '',
        `Assistant response:\n${input.assistantResponse}`
      ].join('\n')
    }
  ]
}

export function buildSaveThreadMessages(messages: MessageRecord[]): ModelMessage[] {
  const transcript = messages
    .map((message) => `[${message.role}] ${normalizeWhitespace(message.content)}`)
    .join('\n')

  return [
    {
      role: 'system',
      content: [
        'Review the full conversation transcript and extract durable long-term memory updates.',
        'Return JSON only.',
        'Schema: {"candidates":[{"topic":"string","title":"string","content":"string","unitType":"fact|preference|decision|plan|procedure|learning|context|event","importance":0.0}]}',
        'If no durable long-term knowledge is present, return {"candidates":[]}. Do not invent weak observations to fill the array.',
        'Keep only durable knowledge that should survive beyond this single thread.',
        'Emit at most one candidate per durable topic.',
        'Prefer stable canonical topics, stable canonical titles, and normalized factual wording.',
        'Reuse the same topic key and title for repeated long-term topics instead of inventing variants.',
        'When the memory is about the user, prefer "<username> + objective description" if the username is explicitly known from context.',
        'If the username is not explicitly known, omit the subject instead of writing "the user" or other chat-role labels.',
        'Content must be compact durable wording, not a story about this thread.',
        'Exclude temporary status, filler, speculation, and thread-specific narration.',
        'Do not use phrases like "this time", "just now", "currently", "we discussed", "it seems", or "maybe".',
        'Do not write conversational summaries like "the user asked", "we talked about", or "the assistant said".',
        'Examples:',
        'Bad: "the user prefers concise status updates."',
        'Good: "<username> prefers concise status updates."',
        'Bad: "we discussed using the repo root for commands."',
        'Good: "<username> uses the Yachiyo repo root for commands."',
        'Bad: "this time the user mentioned disliking bureaucratic language."',
        'Good: "<username> dislikes bureaucratic or overly formal language."',
        'Do not emit multiple near-duplicate candidates for the same long-term topic.'
      ].join('\n')
    },
    {
      role: 'user',
      content: `Thread transcript:\n${transcript}`
    }
  ]
}
