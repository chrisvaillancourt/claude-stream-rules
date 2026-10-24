// Rule files: parsing, validation, compiling and matching. Pure: no `$`, no I/O.
import type { Repeat, RuleSource, RuleSpec, Scope } from '../types'

export type Field = string | number | boolean | string[]
export type Rule = RuleSpec & { regexes: RegExp[] }

const KEY = /^([A-Za-z_][\w-]*):(?:\s+(.*)|\s*)$/

/** Strips an unquoted ` # comment`, then reads one scalar: quoted, boolean, number or plain. */
function scalar(raw: string): string | number | boolean {
  const s = raw.trim()
  if (s.startsWith("'")) {
    const end = findQuoteEnd(s, "'")
    return s.slice(1, end).replace(/''/g, "'")
  }
  if (s.startsWith('"')) {
    const end = findQuoteEnd(s, '"')
    return s.slice(1, end).replace(/\\(["\\])/g, '$1')
  }
  const plain = s.replace(/\s+#.*$/, '').trim()
  if (plain === 'true') return true
  if (plain === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(plain)) return Number(plain)
  return plain
}

/** Index of the closing quote of a string starting at 0; the string's length when unclosed. */
function findQuoteEnd(s: string, q: string): number {
  for (let i = 1; i < s.length; i++) {
    if (q === "'" && s[i] === "'" && s[i + 1] === "'") {
      i++
      continue
    }
    if (q === '"' && s[i] === '\\') {
      i++
      continue
    }
    if (s[i] === q) return i
  }
  return s.length
}

/** Splits `a, 'b, c', d` on the commas outside quotes. */
function splitList(inner: string): string[] {
  const items: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!
    if (quote) {
      if (c === quote && quote === "'" && inner[i + 1] === "'") {
        cur += "''"
        i++
        continue
      }
      if (c === '\\' && quote === '"') {
        cur += c + (inner[i + 1] ?? '')
        i++
        continue
      }
      if (c === quote) quote = null
      cur += c
    } else if (c === "'" || c === '"') {
      quote = c
      cur += c
    } else if (c === ',') {
      items.push(cur)
      cur = ''
    } else cur += c
  }
  if (cur.trim() !== '') items.push(cur)
  return items.map(i => String(scalar(i))).filter(i => i !== '')
}

function value(raw: string): Field {
  const s = raw.trim()
  if (s.startsWith('[')) {
    const close = s.lastIndexOf(']')
    return splitList(s.slice(1, close < 0 ? s.length : close))
  }
  return scalar(s)
}

/** Reads `---` frontmatter (a small YAML subset: scalars, quoted strings, lists) and the body after it. */
export function parseFrontmatter(text: string): { fields: Record<string, Field>; body: string } | { error: string } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { error: 'no frontmatter (the file must start with ---)' }
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (end < 0) return { error: 'frontmatter is not closed with ---' }
  const fields: Record<string, Field> = {}
  for (let i = 1; i < end; i++) {
    const line = lines[i]!
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const m = KEY.exec(line)
    if (!m) return { error: `frontmatter line ${i + 1} is not "key: value": ${line.trim()}` }
    const key = m[1]!
    const rest = m[2] ?? ''
    if (rest.trim() !== '' && !rest.trim().startsWith('#')) {
      fields[key] = value(rest)
      continue
    }
    const items: string[] = []
    while (i + 1 < end && /^\s+-\s+/.test(lines[i + 1]!)) {
      i++
      items.push(String(scalar(lines[i]!.replace(/^\s+-\s+/, ''))))
    }
    fields[key] = items.length > 0 ? items : ''
  }
  return { fields, body: lines.slice(end + 1).join('\n').trim() }
}

/** A condition's source to a RegExp: leading `(?i)`, `(?m)`, `(?s)` (or `(?ims)`) become flags. */
export function compileCondition(source: string): RegExp | { error: string } {
  let rest = source
  const flags = new Set<string>()
  for (let m = /^\(\?([ims]+)\)/.exec(rest); m; m = /^\(\?([ims]+)\)/.exec(rest)) {
    for (const f of m[1]!) flags.add(f)
    rest = rest.slice(m[0].length)
  }
  try {
    const re = new RegExp(rest, [...flags].join(''))
    if (re.test('')) return { error: 'it matches empty text, so it would match everything' }
    return re
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export function parseScope(word: string): Scope | undefined {
  const w = word.trim()
  const lower = w.toLowerCase()
  if (lower === 'text' || lower === 'prose') return { kind: 'text' }
  if (lower === 'thinking') return { kind: 'thinking' }
  if (lower === 'tool' || lower === 'toolcall') return { kind: 'tool' }
  const m = /^tool:([\w.-]+)(?:\((.+)\))?$/i.exec(w)
  if (!m) return undefined
  return m[2] ? { kind: 'tool', tool: m[1]!, glob: m[2] } : { kind: 'tool', tool: m[1]! }
}

const list = (f: Field | undefined): string[] | undefined =>
  f === undefined || f === '' ? undefined : Array.isArray(f) ? f : [String(f)]

/** Parses and validates one rule file. `fileName` gives the default name. */
export function parseRule(text: string, fileName: string, source: RuleSource, path: string): { rule: RuleSpec } | { error: string } {
  const fm = parseFrontmatter(text)
  if ('error' in fm) return fm
  const f = fm.fields
  const name = typeof f.name === 'string' && f.name !== '' ? f.name : fileName.replace(/\.md$/i, '')
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return { error: 'name must be letters, digits, - and _' }

  const conditions = list(f.condition) ?? []
  for (const [i, c] of conditions.entries()) {
    const re = compileCondition(c)
    if (!(re instanceof RegExp)) return { error: `condition ${i + 1} is not a valid regex: ${re.error}` }
  }
  const question = typeof f.question === 'string' && f.question.trim() !== '' ? f.question.trim() : undefined
  if (f.question !== undefined && question === undefined) return { error: 'question must be a line of text' }
  if (conditions.length === 0 && question === undefined) return { error: 'a rule needs a condition or a question' }

  const scope: Scope[] = []
  for (const word of list(f.scope) ?? ['text', 'tool']) {
    const s = parseScope(word)
    if (!s) return { error: `unknown scope: ${word}` }
    scope.push(s)
  }

  const bool = (key: string, fallback: boolean): boolean | { error: string } => {
    const v = f[key]
    if (v === undefined) return fallback
    return typeof v === 'boolean' ? v : { error: `${key} must be true or false` }
  }
  const interrupt = bool('interrupt', true)
  if (typeof interrupt !== 'boolean') return interrupt
  const enabled = bool('enabled', true)
  if (typeof enabled !== 'boolean') return enabled

  let repeat: Repeat | null = null
  if (f.repeat !== undefined) {
    if (f.repeat !== 'once' && f.repeat !== 'always' && f.repeat !== 'after-gap') return { error: 'repeat must be once, always or after-gap' }
    repeat = f.repeat
  }
  const gap = f.gap === undefined ? 10 : f.gap
  if (typeof gap !== 'number' || !Number.isInteger(gap) || gap < 1) return { error: 'gap must be a whole number of 1 or more' }

  if (fm.body === '') return { error: 'the rule has no body (the message the model is given)' }
  const description = typeof f.description === 'string' ? f.description : ''
  return {
    rule: {
      name,
      description,
      conditions,
      scope,
      interrupt,
      repeat,
      gap,
      ...(question !== undefined ? { question } : {}),
      enabled,
      body: fm.body,
      source,
      path,
    },
  }
}

function globToRegExp(glob: string): RegExp {
  let out = ''
  const g = glob.replace(/\\/g, '/')
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++
        if (g[i + 1] === '/') {
          i++
          out += '(?:.*/)?'
        } else out += '.*'
      } else out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else if (c === '{') {
      const close = g.indexOf('}', i)
      if (close < 0) out += '\\{'
      else {
        out += `(?:${g
          .slice(i + 1, close)
          .split(',')
          .map(p => p.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
          .join('|')})`
        i = close
      }
    } else out += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

/** Whether a glob matches the path, any trailing part of it after a `/`, or its file name. */
export function globMatches(glob: string, path: string): boolean {
  const re = globToRegExp(glob)
  const p = path.replace(/\\/g, '/')
  if (re.test(p)) return true
  for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', i + 1)) {
    if (re.test(p.slice(i + 1))) return true
  }
  return false
}

const RESERVED = new Set(['tool', 'tool_use_id', 'consent', 'agentId'])

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** What a rule reads of a tool call: the text it adds or runs, and the path it touches. */
export function projectTool(tool: string, input: unknown): { text: string; path?: string } {
  const o = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const path = str(o.file_path) ?? str(o.notebook_path) ?? str(o.path)
  const withPath = (text: string) => (path !== undefined ? { text, path } : { text })
  switch (tool.toLowerCase()) {
    case 'bash':
      return { text: str(o.command) ?? '' }
    case 'edit':
      return withPath(str(o.new_string) ?? '')
    case 'multiedit':
      return withPath(
        (Array.isArray(o.edits) ? o.edits : [])
          .map(e => str((e as Record<string, unknown>)?.new_string) ?? '')
          .join('\n'),
      )
    case 'write':
      return withPath(str(o.content) ?? '')
    case 'notebookedit':
      return withPath(str(o.new_source) ?? '')
    default: {
      const rest: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(o)) if (!RESERVED.has(k)) rest[k] = v
      return withPath(JSON.stringify(rest))
    }
  }
}

export function compile(specs: readonly RuleSpec[]): Rule[] {
  return specs.map(s => ({
    ...s,
    regexes: s.conditions.map(compileCondition).filter((r): r is RegExp => r instanceof RegExp),
  }))
}

const live = (r: Rule) => r.enabled && r.question === undefined

/** Stream rules (not judged) scoped to `kind` whose condition matches the text. */
export function matchText(rules: readonly Rule[], kind: 'text' | 'thinking', text: string): Rule[] {
  return rules.filter(r => live(r) && r.scope.some(s => s.kind === kind) && r.regexes.some(re => re.test(text)))
}

/** Stream rules whose tool scope covers this call and whose condition matches what it adds. */
export function matchTool(rules: readonly Rule[], tool: string, input: unknown): Rule[] {
  const { text, path } = projectTool(tool, input)
  return rules.filter(
    r =>
      live(r) &&
      r.scope.some(
        s =>
          s.kind === 'tool' &&
          (s.tool === undefined || s.tool.toLowerCase() === tool.toLowerCase()) &&
          (s.glob === undefined || (path !== undefined && globMatches(s.glob, path))),
      ) &&
      r.regexes.some(re => re.test(text)),
  )
}

/** One rule per name, sorted: a project rule beats a user one, and the first file of a source wins. */
export function mergeRules(specs: readonly RuleSpec[]): RuleSpec[] {
  const byName = new Map<string, RuleSpec>()
  for (const s of specs) {
    const held = byName.get(s.name)
    if (!held || (held.source === 'user' && s.source === 'project')) byName.set(s.name, s)
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
