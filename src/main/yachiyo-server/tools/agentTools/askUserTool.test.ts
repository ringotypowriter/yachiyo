import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ASK_USER_MAX_CHOICES,
  ASK_USER_MAX_QUESTION_CHARS,
  ASK_USER_MAX_QUESTIONS_PER_RUN,
  askUserToolInputSchema,
  createAskUserTool,
  type AskUserToolOutput
} from './askUserTool.ts'

function makeQuestion(length: number): string {
  return 'Q'.repeat(length - 1) + '?'
}

test('askUser input accepts one concise question with concrete choices', () => {
  const result = askUserToolInputSchema.safeParse({
    question: 'Which extraction direction should I use?',
    choices: ['Use entity and relation types', 'Keep the current design']
  })

  assert.equal(result.success, true)
  if (result.success) {
    assert.deepEqual(result.data, {
      question: 'Which extraction direction should I use?',
      choices: ['Use entity and relation types', 'Keep the current design']
    })
  }
})

test('askUser input rejects verbose questions before they reach the user', () => {
  const result = askUserToolInputSchema.safeParse({
    question: makeQuestion(ASK_USER_MAX_QUESTION_CHARS + 1),
    choices: ['Approve this direction', 'Revise the direction']
  })

  assert.equal(result.success, false)
})

test('askUser input accepts arbitrary short choices without semantic filtering', () => {
  const result = askUserToolInputSchema.safeParse({
    question: 'Which direction should I use?',
    choices: ['Add another entity type: ...', 'Other']
  })

  assert.equal(result.success, true)
  if (result.success) {
    assert.deepEqual(result.data.choices, ['Add another entity type: ...', 'Other'])
  }
})

test('askUser prompt guides the model away from placeholder choices', () => {
  const tool = createAskUserTool({
    waitForUserAnswer: async () => 'answer'
  })

  assert.match(tool.description ?? '', /placeholder/i)
  assert.match(tool.description ?? '', /unfinished/i)
})

test('askUser input limits choices to the quick-pick range', () => {
  const result = askUserToolInputSchema.safeParse({
    question: 'Which direction should I use?',
    choices: Array.from(
      { length: ASK_USER_MAX_CHOICES + 1 },
      (_, index) => `Concrete choice ${index}`
    )
  })

  assert.equal(result.success, false)
})

test('askUser stops waiting for answers after the per-run question limit', async () => {
  let answeredCount = 0
  const tool = createAskUserTool({
    waitForUserAnswer: async () => {
      answeredCount++
      return 'answer'
    }
  })
  const execute = tool.execute!

  for (let index = 0; index < ASK_USER_MAX_QUESTIONS_PER_RUN; index++) {
    const result = (await execute(
      { question: `Question ${index}?` },
      { abortSignal: AbortSignal.timeout(5000), toolCallId: `ask-${index}`, messages: [] }
    )) as AskUserToolOutput
    assert.equal(result.error, undefined)
  }

  const limited = (await execute(
    { question: 'One more question?' },
    { abortSignal: AbortSignal.timeout(5000), toolCallId: 'ask-limited', messages: [] }
  )) as AskUserToolOutput

  assert.equal(limited.error, 'Ask limit exceeded')
  assert.equal(answeredCount, ASK_USER_MAX_QUESTIONS_PER_RUN)
})
