// Tool routing's matcher: which native-tool families a Bash command could be
// replaced by. Pure: no `$`, no I/O.
//
// A closed, bounded, linear scanner, not a shell parser. It understands
// quotes, escapes, comments, `NAME=value` prefixes, sequencing (`;` `&&` `||`
// `&` newline), pipelines (`|` `|&`) and redirections. Anything else it meets
// (expansions, substitutions, heredocs, grouping, control flow, a malformed
// quote) makes the whole command `unsupported`: routing lets it run. Each
// family then accepts only a closed option grammar; any other option exempts
// the command. `hooks/bash.test.ts` holds the standing corpus.

/** Commands longer than this (UTF-8 bytes) are not analyzed. */
export const MAX_BYTES = 64 * 1024
/** Commands with more simple commands than this are not analyzed. */
export const MAX_SEGMENTS = 256

export type Family = 'read' | 'edit' | 'search' | 'files'

export type Classification =
  /** Understood. `families`: the families of its routable commands, first seen first; empty when none. */
  | { kind: 'supported'; families: Family[] }
  /** Syntax the matcher doesn't model; `reason` names it and never quotes the command. */
  | { kind: 'unsupported'; reason: string }
  | { kind: 'limit'; reason: string }

/** One shell word after quote removal. `raw` is its source; `special` marks unquoted glob, brace or tilde characters. */
type Word = { text: string; raw: string; special: boolean }

type Segment = {
  words: Word[]
  /** stdin or stdout is redirected (stderr alone doesn't count). */
  redirected: boolean
  /** Part of a pipeline, as producer or consumer. */
  piped: boolean
}

class Unsupported extends Error {}
class Limit extends Error {}

const RESERVED = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'select', 'function', 'time', 'coproc', '!', '[[', ']]', '{', '}'])
const CONTINUES = new Set(['|', '|&', '&&', '||'])

function utf8Length(s: string, cap: number): number {
  let n = 0
  for (let i = 0; i < s.length && n <= cap; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/** After an unquoted or double-quoted `$`: does this start an expansion? */
const startsExpansion = (c: string | undefined) => c !== undefined && /[A-Za-z_{(0-9@*#?!$-]/.test(c)

/** Splits a command into simple commands. Throws Unsupported or Limit. */
function scan(s: string): Segment[] {
  const segments: Segment[] = []
  let seg: Segment = { words: [], redirected: false, piped: false }
  let pipeIn = false
  /** The operator that ended the last segment, while the current one is still empty. */
  let lastOp: string | null = null
  let text = ''
  let rawStart = -1
  let special = false
  let inWord = false
  /** A redirection waiting for its target word: whether it counts as stdin/stdout. */
  let pendingRedirect: { counts: boolean } | null = null

  const endWord = (end: number) => {
    if (!inWord) return
    const w: Word = { text, raw: s.slice(rawStart, end), special }
    inWord = false
    text = ''
    special = false
    if (pendingRedirect !== null) {
      if (pendingRedirect.counts) seg.redirected = true
      pendingRedirect = null
      return
    }
    seg.words.push(w)
  }
  const startWord = (i: number) => {
    if (!inWord) {
      inWord = true
      rawStart = i
    }
  }
  const empty = () => seg.words.length === 0 && !seg.redirected
  const endSegment = (op: string, i: number) => {
    endWord(i)
    if (pendingRedirect !== null) throw new Unsupported('a redirection without a target')
    const isPipe = op === '|' || op === '|&'
    if (empty()) {
      if (op === '\n' && (lastOp === null || CONTINUES.has(lastOp) || lastOp === ';' || lastOp === '&' || lastOp === '\n')) return
      if (op === 'end' && (lastOp === null || lastOp === ';' || lastOp === '&' || lastOp === '\n')) return
      throw new Unsupported(`an operator with no command before it`)
    }
    if (pipeIn) seg.piped = true
    if (isPipe) seg.piped = true
    segments.push(seg)
    if (segments.length > MAX_SEGMENTS) throw new Limit(`more than ${MAX_SEGMENTS} commands`)
    pipeIn = isPipe
    lastOp = op
    seg = { words: [], redirected: false, piped: false }
  }

  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (c === ' ' || c === '\t') {
      endWord(i)
      i++
    } else if (c === '\n') {
      // A newline after `|`, `&&` or `||` continues the command.
      if (!inWord && empty() && lastOp !== null && CONTINUES.has(lastOp)) {
        i++
        continue
      }
      endSegment('\n', i)
      i++
    } else if (c === '#' && !inWord) {
      while (i < s.length && s[i] !== '\n') i++
    } else if (c === '\\') {
      if (s[i + 1] === '\n') {
        i += 2
        continue
      }
      if (i + 1 >= s.length) throw new Unsupported('a trailing backslash')
      startWord(i)
      text += s[i + 1]
      i += 2
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1)
      if (end < 0) throw new Unsupported('an unclosed quote')
      startWord(i)
      text += s.slice(i + 1, end)
      i = end + 1
    } else if (c === '"') {
      startWord(i)
      let j = i + 1
      for (; j < s.length && s[j] !== '"'; j++) {
        const d = s[j]!
        if (d === '\\' && j + 1 < s.length && '$`"\\\n'.includes(s[j + 1]!)) {
          if (s[j + 1] !== '\n') text += s[j + 1]
          j++
        } else if (d === '`') throw new Unsupported('command substitution')
        else if (d === '$' && startsExpansion(s[j + 1])) throw new Unsupported(s[j + 1] === '(' ? 'command substitution' : 'parameter expansion')
        else text += d
      }
      if (j >= s.length) throw new Unsupported('an unclosed quote')
      i = j + 1
    } else if (c === '`') {
      throw new Unsupported('command substitution')
    } else if (c === '$') {
      const d = s[i + 1]
      if (d === '(') throw new Unsupported('command substitution')
      if (d === "'" || d === '"') throw new Unsupported('$-quoting')
      if (startsExpansion(d)) throw new Unsupported('parameter expansion')
      startWord(i)
      text += c
      i++
    } else if (c === ';') {
      if (s[i + 1] === ';' || s[i + 1] === '&') throw new Unsupported('control flow')
      endSegment(';', i)
      i++
    } else if (c === '&') {
      if (s[i + 1] === '&') {
        endSegment('&&', i)
        i += 2
      } else if (s[i + 1] === '>') {
        endWord(i)
        pendingRedirect = { counts: true }
        i += s[i + 2] === '>' ? 3 : 2
      } else {
        endSegment('&', i)
        i++
      }
    } else if (c === '|') {
      if (s[i + 1] === '|') {
        endSegment('||', i)
        i += 2
      } else if (s[i + 1] === '&') {
        endSegment('|&', i)
        i += 2
      } else {
        endSegment('|', i)
        i++
      }
    } else if (c === '(' || c === ')') {
      throw new Unsupported('a subshell or group')
    } else if (c === '<' || c === '>') {
      // A digits-only word right before the operator is its file descriptor.
      let fd: number | null = null
      if (inWord && /^\d+$/.test(s.slice(rawStart, i))) {
        fd = Number(s.slice(rawStart, i))
        inWord = false
        text = ''
        special = false
      } else endWord(i)
      if (pendingRedirect !== null) throw new Unsupported('a redirection without a target')
      const rest = s.slice(i, i + 3)
      let len = 1
      if (rest.startsWith('<(') || rest.startsWith('>(')) throw new Unsupported('process substitution')
      if (rest.startsWith('<<<')) len = 3
      else if (rest.startsWith('<<')) throw new Unsupported('a heredoc')
      else if (rest.startsWith('>>') || rest.startsWith('>|') || rest.startsWith('>&') || rest.startsWith('<&') || rest.startsWith('<>')) len = 2
      const input = c === '<' && rest[1] !== '>'
      const targetFd = fd ?? (input ? 0 : 1)
      pendingRedirect = { counts: targetFd === 0 || targetFd === 1 || rest.startsWith('<>') }
      i += len
    } else {
      startWord(i)
      if (c === '*' || c === '?' || c === '[' || c === '{' || c === '}' || (c === '~' && rawStart === i)) special = true
      text += c
      i++
    }
  }
  endSegment('end', s.length)
  return segments
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** The command name, with `/bin/` or `/usr/bin/` taken off. */
function commandName(w: Word): string | undefined {
  if (w.special) return undefined
  const t = w.text
  if (t.startsWith('/usr/bin/')) return t.slice(9)
  if (t.startsWith('/bin/')) return t.slice(5)
  return t.includes('/') ? undefined : t
}

const literal = (w: Word) => !w.special && w.text !== ''
const numeric = (t: string) => /^[+-]?\d+$/.test(t)

/** `cat`, `less`, `more`: no options, one literal ordinary file. */
function plainReader(args: readonly Word[]): boolean {
  let rest = args
  if (rest[0]?.text === '--') rest = rest.slice(1)
  else if (rest.some(a => a.text.startsWith('-') || a.text.startsWith('+'))) return false
  return rest.length === 1 && isFileOperand(rest[0]!)
}

const isFileOperand = (w: Word) => literal(w) && w.text !== '-' && !w.text.startsWith('/dev/')

/** `head`, `tail`: line mode only, one literal file. */
function lineReader(args: readonly Word[]): boolean {
  const operands: Word[] = []
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!.text
    if (operands.length > 0 || !t.startsWith('-') || t === '-') {
      operands.push(args[i]!)
      continue
    }
    if (t === '--') {
      operands.push(...args.slice(i + 1))
      break
    }
    if (t === '-n' || t === '--lines') {
      const v = args[++i]?.text
      if (v === undefined || !numeric(v)) return false
    } else if (/^-n[+-]?\d+$/.test(t) || /^-\d+$/.test(t) || /^--lines=[+-]?\d+$/.test(t)) {
      // a line count
    } else return false
  }
  return operands.length === 1 && isFileOperand(operands[0]!)
}

/**
 * Reads a closed option grammar. `flags`: single letters that take nothing.
 * `withArg`: single letters that take a value (attached or next). `long`:
 * long options taking nothing; `longArg`: long options taking `=value` or the
 * next word. Returns the operands, or undefined on any other option.
 */
function options(
  args: readonly Word[],
  g: { flags: string; withArg: string; long: readonly string[]; longArg: readonly string[] },
  seen: (opt: string, value?: string) => void = () => undefined,
): Word[] | undefined {
  const operands: Word[] = []
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!
    const t = w.text
    if (t === '--') {
      operands.push(...args.slice(i + 1))
      break
    }
    if (!t.startsWith('-') || t === '-') {
      operands.push(w)
      continue
    }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=')
      const name = eq < 0 ? t : t.slice(0, eq)
      if (g.long.includes(name) && eq < 0) seen(name)
      else if (g.longArg.includes(name)) {
        const v = eq < 0 ? args[++i]?.text : t.slice(eq + 1)
        if (v === undefined) return undefined
        seen(name, v)
      } else return undefined
      continue
    }
    for (let j = 1; j < t.length; j++) {
      const c = t[j]!
      if (g.flags.includes(c)) seen(`-${c}`)
      else if (g.withArg.includes(c)) {
        const v = j + 1 < t.length ? t.slice(j + 1) : args[++i]?.text
        if (v === undefined) return undefined
        seen(`-${c}`, v)
        break
      } else return undefined
    }
  }
  return operands
}

/** An explicit `-` path: search stdin, which a path-based tool can't. */
const isStdin = (w: Word) => w.text === '-'

function grepSearch(args: readonly Word[]): boolean {
  let pattern = false
  const ops = options(
    args,
    { flags: 'rRniwlFEHhsIx', withArg: 'eABC', long: ['--recursive', '--line-number', '--ignore-case', '--word-regexp', '--files-with-matches', '--fixed-strings', '--extended-regexp'], longArg: ['--include', '--exclude', '--exclude-dir', '--regexp'] },
    o => {
      if (o === '-e' || o === '--regexp') pattern = true
    },
  )
  if (ops === undefined || !ops.every(literal)) return false
  const paths = pattern ? ops : ops.slice(1)
  return (pattern || ops.length > 0) && paths.length > 0 && !paths.some(isStdin)
}

function rgSearch(args: readonly Word[]): boolean {
  let pattern = false
  const ops = options(
    args,
    { flags: 'niwlFSs', withArg: 'egtABC', long: ['--ignore-case', '--smart-case', '--fixed-strings', '--files-with-matches', '--line-number', '--word-regexp', '--hidden'], longArg: ['--glob', '--type', '--regexp'] },
    o => {
      if (o === '-e' || o === '--regexp') pattern = true
    },
  )
  if (ops === undefined || !ops.every(literal)) return false
  const paths = pattern ? ops : ops.slice(1)
  return (pattern || ops.length > 0) && !paths.some(isStdin)
}

function findFiles(args: readonly Word[]): boolean {
  let i = 0
  while (i < args.length && !args[i]!.text.startsWith('-') && args[i]!.text !== '!') {
    if (!literal(args[i]!)) return false
    i++
  }
  let named = false
  while (i < args.length) {
    const p = args[i]!.text
    const v = args[i + 1]
    if (v === undefined) return false
    if (p === '-name' || p === '-iname') {
      if (v.special) return false
      named = true
    } else if (p !== '-type' || v.text !== 'f') return false
    i += 2
  }
  return named
}

function fdFiles(args: readonly Word[]): boolean {
  let glob = false
  let ok = true
  const ops = options(args, { flags: 'gH', withArg: 't', long: ['--glob', '--hidden'], longArg: ['--type'] }, (o, v) => {
    if (o === '-g' || o === '--glob') glob = true
    if ((o === '-t' || o === '--type') && v !== 'f' && v !== 'file') ok = false
  })
  return ok && glob && ops !== undefined && ops.length >= 1 && ops.every(w => !w.special)
}

function lsFiles(args: readonly Word[]): boolean {
  let recursive = false
  const ops = options(args, { flags: 'R', withArg: '', long: ['--recursive'], longArg: [] }, () => (recursive = true))
  return recursive && ops !== undefined && ops.every(literal)
}

function sedEdit(args: readonly Word[]): boolean {
  let inPlace = false
  let script = false
  const operands: Word[] = []
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!.text
    if (t === '--') {
      operands.push(...args.slice(i + 1))
      break
    }
    if (!t.startsWith('-') || t === '-') {
      operands.push(args[i]!)
      continue
    }
    if (t.startsWith('--')) {
      if (t === '--in-place' || t.startsWith('--in-place=')) inPlace = true
      else if (t.startsWith('--expression=')) script = true
      else if (t === '--expression') {
        if (args[++i] === undefined) return false
        script = true
      } else if (t !== '--regexp-extended' && t !== '--quiet' && t !== '--silent') return false
      continue
    }
    for (let j = 1; j < t.length; j++) {
      const c = t[j]!
      if ('nErsuz'.includes(c)) continue
      if (c === 'i') {
        inPlace = true
        // BSD: a separate suffix word ('' or .bak); GNU: the rest of the cluster.
        const next = args[i + 1]?.text
        if (j + 1 === t.length && next !== undefined && (next === '' || next.startsWith('.'))) i++
        break
      }
      if (c === 'e') {
        if (j + 1 === t.length && args[++i] === undefined) return false
        script = true
        break
      }
      return false // -f (a script file) and anything unknown
    }
  }
  const files = script ? operands : operands.slice(1)
  return inPlace && (script || operands.length > 0) && files.length > 0 && files.every(literal)
}

function perlEdit(args: readonly Word[]): boolean {
  let inPlace = false
  let script = false
  const operands: Word[] = []
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!.text
    if (t === '--') {
      operands.push(...args.slice(i + 1))
      break
    }
    if (!t.startsWith('-') || t === '-' || operands.length > 0) {
      operands.push(args[i]!)
      continue
    }
    for (let j = 1; j < t.length; j++) {
      const c = t[j]!
      if ('pnlaw'.includes(c)) continue
      if (c === 'i') {
        inPlace = true
        break // the rest of the cluster is the backup extension
      }
      if (c === 'e' || c === 'E') {
        if (j + 1 === t.length && args[++i] === undefined) return false
        script = true
        break
      }
      return false
    }
  }
  return inPlace && script && operands.length > 0 && operands.every(literal)
}

function awkEdit(args: readonly Word[]): boolean {
  let inPlace = false
  let ok = true
  const ops = options(args, { flags: '', withArg: 'ivF', long: [], longArg: [] }, (o, v) => {
    if (o === '-i') {
      if (v === 'inplace') inPlace = true
      else ok = false
    }
  })
  return ok && inPlace && ops !== undefined && ops.length >= 2 && ops.slice(1).every(literal)
}

function familyOf(name: string, args: readonly Word[]): Family | undefined {
  switch (name) {
    case 'cat':
    case 'less':
    case 'more':
      return plainReader(args) ? 'read' : undefined
    case 'head':
    case 'tail':
      return lineReader(args) ? 'read' : undefined
    case 'grep':
      return grepSearch(args) ? 'search' : undefined
    case 'rg':
      return rgSearch(args) ? 'search' : undefined
    case 'find':
      return findFiles(args) ? 'files' : undefined
    case 'fd':
      return fdFiles(args) ? 'files' : undefined
    case 'ls':
      return lsFiles(args) ? 'files' : undefined
    case 'sed':
      return sedEdit(args) ? 'edit' : undefined
    case 'perl':
      return perlEdit(args) ? 'edit' : undefined
    case 'awk':
    case 'gawk':
      return awkEdit(args) ? 'edit' : undefined
    default:
      return undefined
  }
}

/** Which native-tool families a Bash command's routable commands belong to. Never throws. */
export function classifyBash(command: string): Classification {
  if (utf8Length(command, MAX_BYTES) > MAX_BYTES) return { kind: 'limit', reason: `longer than ${MAX_BYTES / 1024} KiB` }
  let segments: Segment[]
  try {
    segments = scan(command)
  } catch (err) {
    if (err instanceof Limit) return { kind: 'limit', reason: err.message }
    if (err instanceof Unsupported) return { kind: 'unsupported', reason: err.message }
    return { kind: 'unsupported', reason: 'the matcher failed' }
  }
  const families: Family[] = []
  for (const seg of segments) {
    let k = 0
    while (k < seg.words.length && ASSIGNMENT.test(seg.words[k]!.raw)) k++
    const head = seg.words[k]
    if (head === undefined) continue
    if (RESERVED.has(head.raw)) return { kind: 'unsupported', reason: head.raw === '{' || head.raw === '}' ? 'a subshell or group' : 'control flow' }
    if (seg.piped || seg.redirected) continue
    const name = commandName(head)
    const f = name === undefined ? undefined : familyOf(name, seg.words.slice(k + 1))
    if (f !== undefined && !families.includes(f)) families.push(f)
  }
  return { kind: 'supported', families }
}
