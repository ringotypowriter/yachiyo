const DEFAULT_MAX_LINES = 1500
const LINE_BREAK_PATTERN = /\r\n|[\n\r\u2028\u2029]/gu
const FINAL_LINE_BREAK_PATTERN = /(?:\r\n|[\n\r\u2028\u2029])$/u

const maxTypescriptFileLinesRule = {
  meta: {
    type: 'layout',
    docs: {
      description: 'limit TypeScript files to a maximum line count'
    },
    schema: [
      {
        type: 'object',
        properties: {
          max: {
            type: 'integer',
            minimum: 1
          }
        },
        additionalProperties: false
      }
    ],
    messages: {
      tooManyLines: 'TypeScript file has {{lineCount}} lines. Maximum allowed is {{max}}.'
    }
  },
  create(context) {
    const [{ max = DEFAULT_MAX_LINES } = {}] = context.options

    return {
      Program(node) {
        const sourceCode = context.sourceCode
        const lineBreakCount = sourceCode.text.match(LINE_BREAK_PATTERN)?.length ?? 0
        const lineCount =
          sourceCode.text.length === 0
            ? 0
            : lineBreakCount + (FINAL_LINE_BREAK_PATTERN.test(sourceCode.text) ? 0 : 1)

        if (lineCount <= max) {
          return
        }

        context.report({
          node,
          loc: {
            line: max + 1,
            column: 0
          },
          messageId: 'tooManyLines',
          data: {
            lineCount: String(lineCount),
            max: String(max)
          }
        })
      }
    }
  }
}

export default maxTypescriptFileLinesRule
