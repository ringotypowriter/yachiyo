import { parse } from '@babel/parser'

interface AstNode {
  type: string
  start?: number | null
  end?: number | null
  [key: string]: unknown
}

interface TextEdit {
  start: number
  end: number
  text: string
}

export interface CompiledJsReplCell {
  source: string
  bindingNames: string[]
  capturesFinalExpression: boolean
}

const IMPORT_HELPER = '__yachiyoJsReplImport__'
const PUBLISHED_BINDINGS = '__yachiyoJsReplPublishedBindings__'

function nodeRange(node: AstNode): { start: number; end: number } {
  if (typeof node.start !== 'number' || typeof node.end !== 'number') {
    throw new Error(`JavaScript parser omitted the source range for ${node.type}.`)
  }
  return { start: node.start, end: node.end }
}

function isAstNode(value: unknown): value is AstNode {
  return Boolean(
    value && typeof value === 'object' && 'type' in value && typeof value.type === 'string'
  )
}

function identifierName(node: unknown): string | undefined {
  if (!isAstNode(node)) return undefined
  return node.type === 'Identifier' && typeof node.name === 'string' ? node.name : undefined
}

function collectBindingNames(pattern: unknown, names: string[]): void {
  if (!isAstNode(pattern)) return
  const node = pattern
  const name = identifierName(node)
  if (name) {
    names.push(name)
    return
  }

  if (node.type === 'RestElement') {
    collectBindingNames(node.argument, names)
    return
  }
  if (node.type === 'AssignmentPattern') {
    collectBindingNames(node.left, names)
    return
  }
  if (node.type === 'ArrayPattern' && Array.isArray(node.elements)) {
    for (const element of node.elements) collectBindingNames(element, names)
    return
  }
  if (node.type === 'ObjectPattern' && Array.isArray(node.properties)) {
    for (const property of node.properties) {
      if (!isAstNode(property)) continue
      collectBindingNames(
        property.type === 'RestElement' ? property.argument : property.value,
        names
      )
    }
  }
}

function publication(names: readonly string[]): string {
  return names
    .map(
      (name) =>
        `${PUBLISHED_BINDINGS}[${JSON.stringify(name)}] = true; globalThis[${JSON.stringify(name)}] = ${name};`
    )
    .join('\n')
}

function importedName(specifier: AstNode): string {
  const imported = specifier.imported
  const identifier = identifierName(imported)
  if (identifier) return identifier
  if (
    imported &&
    typeof imported === 'object' &&
    'value' in imported &&
    typeof imported.value === 'string'
  ) {
    return imported.value
  }
  throw new Error('Unsupported JavaScript import specifier.')
}

function buildImportReplacement(node: AstNode, index: number): { source: string; names: string[] } {
  const sourceNode = node.source
  if (
    !sourceNode ||
    typeof sourceNode !== 'object' ||
    !('value' in sourceNode) ||
    typeof sourceNode.value !== 'string'
  ) {
    throw new Error('JavaScript import is missing a string module specifier.')
  }
  const attributes = [
    ...(Array.isArray(node.attributes) ? node.attributes : []),
    ...(Array.isArray(node.assertions) ? node.assertions : [])
  ]
  if (attributes.length > 0) {
    throw new Error('JavaScript REPL imports do not support import attributes.')
  }
  const moduleName = sourceNode.value
  const specifiers = Array.isArray(node.specifiers) ? node.specifiers.filter(isAstNode) : []
  if (specifiers.length === 0) {
    return { source: `await ${IMPORT_HELPER}(${JSON.stringify(moduleName)});`, names: [] }
  }

  const tempName = `__yachiyoJsReplImport${index}__`
  const lines = [`var ${tempName} = await ${IMPORT_HELPER}(${JSON.stringify(moduleName)});`]
  const names: string[] = []

  for (const specifier of specifiers) {
    const local = identifierName(specifier.local)
    if (!local) throw new Error('Unsupported JavaScript import binding.')
    names.push(local)
    if (specifier.type === 'ImportDefaultSpecifier') {
      lines.push(`var ${local} = ${tempName}.default;`)
    } else if (specifier.type === 'ImportNamespaceSpecifier') {
      lines.push(`var ${local} = ${tempName};`)
    } else if (specifier.type === 'ImportSpecifier') {
      lines.push(`var ${local} = ${tempName}[${JSON.stringify(importedName(specifier))}];`)
    } else {
      throw new Error(`Unsupported JavaScript import specifier: ${specifier.type}.`)
    }
  }

  lines.push(publication(names))
  return { source: lines.join('\n'), names }
}

function walkAst(value: unknown, visit: (node: AstNode) => void): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) walkAst(item, visit)
    return
  }

  const node = value as AstNode
  if (typeof node.type === 'string') visit(node)
  for (const [key, child] of Object.entries(node)) {
    if (
      key === 'loc' ||
      key === 'start' ||
      key === 'end' ||
      key === 'extra' ||
      key.endsWith('Comments')
    ) {
      continue
    }
    walkAst(child, visit)
  }
}

function applyEdits(source: string, edits: TextEdit[]): string {
  const ordered = edits
    .map((edit, index) => ({ edit, index }))
    .sort((a, b) => b.edit.start - a.edit.start || b.edit.end - a.edit.end || b.index - a.index)
  let output = source
  for (const { edit } of ordered) {
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end)
  }
  return output
}

export function compileJsReplCell(code: string): CompiledJsReplCell {
  const file = parse(code, {
    sourceType: 'module',
    allowReturnOutsideFunction: true,
    createImportExpressions: true
  })
  const body = file.program.body as unknown as AstNode[]
  const directives = file.program.directives as unknown as AstNode[]
  const edits: TextEdit[] = []
  const bindingNames = new Set<string>()
  let importIndex = 0

  for (const node of body) {
    const { start, end } = nodeRange(node)
    if (node.type === 'ImportDeclaration') {
      const replacement = buildImportReplacement(node, importIndex++)
      for (const name of replacement.names) bindingNames.add(name)
      edits.push({ start, end, text: replacement.source })
      continue
    }
    if (node.type.startsWith('Export')) {
      throw new Error('JavaScript REPL cells do not support export declarations.')
    }
    if (node.type === 'VariableDeclaration') {
      const declarations = Array.isArray(node.declarations)
        ? node.declarations.filter(isAstNode)
        : []
      const names: string[] = []
      for (const declaration of declarations) collectBindingNames(declaration.id, names)
      for (const name of names) bindingNames.add(name)
      if (node.kind === 'const' || node.kind === 'let') {
        edits.push({ start, end: start + String(node.kind).length, text: 'var' })
      }
      if (names.length > 0) edits.push({ start: end, end, text: `\n${publication(names)}` })
      continue
    }
    if (node.type === 'ClassDeclaration' || node.type === 'FunctionDeclaration') {
      const id = isAstNode(node.id) ? node.id : undefined
      const name = identifierName(id)
      if (!name || !id) continue
      const idRange = nodeRange(id)
      const declarationPrefix = code.slice(start, idRange.end)
      edits.push({ start, end: idRange.end, text: `var ${name} = ${declarationPrefix}` })
      edits.push({ start: end, end, text: `\n${publication([name])}` })
      bindingNames.add(name)
    }
  }

  walkAst(file.program, (node) => {
    if (node.type === 'ImportExpression') {
      const { start } = nodeRange(node)
      edits.push({ start, end: start + 'import'.length, text: IMPORT_HELPER })
      return
    }
    if (node.type === 'CallExpression') {
      const callee = isAstNode(node.callee) ? node.callee : undefined
      if (callee?.type !== 'Import') return
      const { start, end } = nodeRange(callee)
      edits.push({ start, end, text: IMPORT_HELPER })
    }
  })

  let capturesFinalExpression = false
  const finalNode =
    [...body].reverse().find((node) => node.type !== 'EmptyStatement') ?? directives.at(-1)
  if (finalNode && (finalNode.type === 'ExpressionStatement' || finalNode.type === 'Directive')) {
    const { start, end } = nodeRange(finalNode)
    const statement = code.slice(start, end)
    const trailingSemicolon = statement.match(/;\s*$/)
    const expressionEnd =
      trailingSemicolon?.index === undefined ? end : start + trailingSemicolon.index
    edits.push({ start, end: start, text: 'return (' })
    edits.push({ start: expressionEnd, end: expressionEnd, text: ')' })
    capturesFinalExpression = true
  }

  if (bindingNames.has(PUBLISHED_BINDINGS)) {
    throw new Error(`JavaScript binding ${JSON.stringify(PUBLISHED_BINDINGS)} is reserved.`)
  }

  const transformed = applyEdits(code, edits)
  const bindings = [...bindingNames]
  const finalPublications = bindings
    .map(
      (name) =>
        `if (${PUBLISHED_BINDINGS}[${JSON.stringify(name)}]) globalThis[${JSON.stringify(name)}] = ${name};`
    )
    .join('\n')
  const source = bindings.length
    ? `(async () => {\nvar ${PUBLISHED_BINDINGS} = Object.create(null);\ntry {\n${transformed}\n} finally {\n${finalPublications}\n}\n})()`
    : `(async () => {\n${transformed}\n})()`

  return {
    source,
    bindingNames: bindings,
    capturesFinalExpression
  }
}
