import { code as codePlugin } from '@streamdown/code'
import type { BundledLanguage } from 'shiki'

const extToLang: Record<string, BundledLanguage> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  py: 'python',
  rs: 'rust',
  go: 'go',
  rb: 'ruby',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  scss: 'scss',
  html: 'html',
  vue: 'vue',
  svelte: 'svelte',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'fish',
  lua: 'lua',
  php: 'php',
  r: 'r',
  scala: 'scala',
  zig: 'zig',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  ml: 'ocaml',
  vim: 'viml',
  tf: 'hcl',
  graphql: 'graphql',
  gql: 'graphql',
  xml: 'xml',
  svg: 'xml',
  dockerfile: 'dockerfile',
  proto: 'proto'
}

export function detectLanguage(filePath: string | undefined): BundledLanguage | null {
  if (!filePath) return null
  const basename = filePath.split('/').pop() ?? ''
  const lower = basename.toLowerCase()
  if (lower === 'dockerfile') return 'dockerfile'
  if (lower === 'makefile') return 'makefile'
  const ext = basename.includes('.') ? basename.split('.').pop()?.toLowerCase() : undefined
  if (!ext) return null
  const lang = extToLang[ext]
  if (lang && codePlugin.supportsLanguage(lang)) return lang
  if (codePlugin.supportsLanguage(ext as BundledLanguage)) return ext as BundledLanguage
  return null
}
