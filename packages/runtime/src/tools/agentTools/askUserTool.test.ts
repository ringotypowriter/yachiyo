import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ASK_USER_MAX_CHOICES,
  ASK_USER_MAX_QUESTION_CHARS,
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

test('askUser answers an unbounded number of questions in a single run', async () => {
  let answeredCount = 0
  const tool = createAskUserTool({
    waitForUserAnswer: async () => {
      answeredCount++
      return 'answer'
    }
  })
  const execute = tool.execute!

  for (let index = 0; index < 10; index++) {
    const result = (await execute(
      { question: `Question ${index}?` },
      { abortSignal: AbortSignal.timeout(5000), toolCallId: `ask-${index}`, messages: [] }
    )) as AskUserToolOutput
    assert.equal(result.error, undefined)
    const block = result.content[0]
    assert.ok(block?.type === 'text', 'expected a text content block')
    assert.equal(block.text, 'answer')
  }

  assert.equal(answeredCount, 10)
})
