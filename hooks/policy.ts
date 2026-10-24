// Pure decisions and text: no `$`, no I/O. register.ts wires them to events.
import type { Config, LoadError, Mode, RuleSpec, Session } from '../types'
import type { Rule } from './rules'

export const INITIAL: Session = { mode: null, corrections: 0, lastError: null, fired: {}, steps: {} }

/** How much of an answer one judged question sends. */
export const JUDGE_MAX_CHARS = 32_000
/** How much recent conversation a draft request sends. */
export const DRAFT_CONTEXT_CHARS = 20_000
/** How many recent assistant messages a draft's conditions are tried on. */
export const DRAFT_CHECK_MESSAGES = 20

function count(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : fallback
}

const model = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : 'haiku')

export function configFrom(options: Record<string, unknown>): Config {
  return {
    enabled: options.enabled !== false,
    maxCorrections: count(options.maxCorrections, 2),
    judgeModel: model(options.judgeModel),
    judgeMaxPerTurn: count(options.judgeMaxPerTurn, 3),
    judgeAction: options.judgeAction === 'correct' ? 'correct' : 'remind',
    draftModel: model(options.draftModel),
  }
}

export function isActive(config: Config, session: Session): boolean {
  return session.mode === null ? config.enabled : session.mode === 'on'
}

export type Command =
  | { kind: 'status' }
  | { kind: 'list' }
  | { kind: 'test'; text: string }
  | { kind: 'set'; mode: Mode }
  | { kind: 'reload' }
  | { kind: 'reset' }
  | { kind: 'help'; error?: string }

export const USAGE = 'Usage: /stream-rules [status|list|test <text>|on|off|reload|reset]'

export function parseArgs(args: string): Command {
  const trimmed = args.trim()
  const [first = '', ...rest] = trimmed.split(/\s+/)
  const word = first.toLowerCase()
  if (word === '' || word === 'status') return { kind: 'status' }
  if (word === 'list') return { kind: 'list' }
  if (word === 'on' || word === 'off') return { kind: 'set', mode: word }
  if (word === 'reload') return { kind: 'reload' }
  if (word === 'reset') return { kind: 'reset' }
  if (word === 'help') return { kind: 'help' }
  if (word === 'test') {
    const text = trimmed.slice(first.length).trim()
    return text === '' || rest.length === 0 ? { kind: 'help', error: 'test needs a text: /stream-rules test <text>' } : { kind: 'test', text }
  }
  return { kind: 'help', error: `Unknown argument: ${trimmed}` }
}

export type DraftCommand =
  | { kind: 'show' }
  | { kind: 'cancel' }
  | { kind: 'save'; dest: 'project' | 'user'; overwrite: boolean }
  | { kind: 'draft'; complaint: string }

export const DRAFT_USAGE = 'Usage: /stream-rules-draft <complaint> | show | save [project|user] [overwrite] | cancel'

export function parseDraftArgs(args: string): DraftCommand {
  const trimmed = args.trim()
  const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0 || (words.length === 1 && words[0] === 'show')) return { kind: 'show' }
  if (words.length === 1 && words[0] === 'cancel') return { kind: 'cancel' }
  if (words[0] === 'save' && words.slice(1).every(w => w === 'project' || w === 'user' || w === 'overwrite')) {
    return { kind: 'save', dest: words.includes('user') ? 'user' : 'project', overwrite: words.includes('overwrite') }
  }
  return { kind: 'draft', complaint: trimmed }
}

/** The key a loop's counters live under. */
export const loopKey = (agentId: string | undefined) => agentId ?? 'main'

/** Whether a rule may fire now. `firedAt` is the response count it last fired at; `steps` is the count now. */
export function isEligible(rule: RuleSpec, via: 'prose' | 'tool', firedAt: number | undefined, steps: number): boolean {
  const repeat = rule.repeat ?? (via === 'tool' ? 'always' : 'once')
  if (firedAt === undefined || repeat === 'always') return true
  if (repeat === 'once') return false
  return steps - firedAt >= rule.gap
}

export function bumpStep(s: Session, loop: string): Session {
  return { ...s, steps: { ...s.steps, [loop]: (s.steps[loop] ?? 0) + 1 } }
}

export function markFired(s: Session, loop: string, names: readonly string[]): Session {
  const at = s.steps[loop] ?? 0
  const mine = { ...(s.fired[loop] ?? {}) }
  for (const n of names) mine[n] = at
  return { ...s, fired: { ...s.fired, [loop]: mine } }
}

export function canCorrect(config: Config, s: Session): boolean {
  return s.corrections < config.maxCorrections
}

const label = (r: RuleSpec) => (r.description ? `"${r.name}" (${r.description})` : `"${r.name}"`)
const ruleBlock = (r: RuleSpec) => `Rule ${label(r)}:\n${r.body}`

/** The corrective prompt after a response was stopped mid-stream. */
export function correctionText(rules: readonly RuleSpec[]): string {
  return [
    'Your previous response was stopped before it finished because it matched a rule set for this session (stream-rules).',
    ...rules.map(ruleBlock),
    "Continue the original task from where the response stopped, following the rule. Don't repeat the text already shown.",
  ].join('\n\n')
}

/** A reminder appended into a loop that can't be (or shouldn't be) stopped. */
export function reminderText(rules: readonly RuleSpec[]): string {
  return [
    'Reminder from stream-rules: your response matched a rule set for this session.',
    ...rules.map(ruleBlock),
    'Follow it from here on.',
  ].join('\n\n')
}

/** The deny reason a refused tool call returns to the model. */
export function denyText(rules: readonly RuleSpec[]): string {
  return [`Refused by stream-rules: this call matched ${rules.length === 1 ? 'a rule' : 'rules'} set for this session.`, ...rules.map(ruleBlock)].join('\n\n')
}

/** The note added after a tool result for a non-interrupting rule. */
export function contextText(rules: readonly RuleSpec[]): string {
  return ['Note from stream-rules: this call matched a rule set for this session.', ...rules.map(ruleBlock)].join('\n\n')
}

/** After a yes from the judge: a reminder, or with judgeAction `correct` the corrective prompt. */
export function judgedText(rules: readonly RuleSpec[], action: 'remind' | 'correct'): string {
  return [
    'Your last answer was checked against a rule set for this session (stream-rules) and did not follow it.',
    ...rules.map(ruleBlock),
    action === 'correct' ? 'Revise the answer so it follows the rule.' : 'Follow it from here on.',
  ].join('\n\n')
}

export function judgePrompt(rule: RuleSpec, answer: string): { system: string; prompt: string } {
  const cut = answer.length > JUDGE_MAX_CHARS ? `${answer.slice(0, JUDGE_MAX_CHARS)}\n[cut]` : answer
  return {
    system: 'You check an assistant reply against one question. Answer with one word: yes or no.',
    prompt: `Question: ${rule.question ?? ''}\n\n<reply>\n${cut}\n</reply>\n\nAnswer yes or no.`,
  }
}

export function parseVerdict(text: string): 'yes' | 'no' | undefined {
  const w = /^\W*(yes|no)\b/i.exec(text.trim())
  return w ? (w[1]!.toLowerCase() as 'yes' | 'no') : undefined
}

export function draftPrompt(complaint: string, recent: string): { system: string; prompt: string } {
  return {
    system: [
      'You write rule files for stream-rules, a Claude Code mod that watches an assistant reply as it streams, and its tool calls, and stops it when a regex matches.',
      'A rule file is markdown with frontmatter, then the message the assistant is given when the rule fires:',
      '---',
      'name: lowercase-with-dashes',
      'description: one line',
      "condition: '<JavaScript regex; a leading (?i) makes it case-insensitive>'",
      'scope: [text]   # text (the reply), tool (any tool input), tool:Bash, tool:Edit(*.ts)',
      '---',
      'One or two sentences telling the assistant what to do instead.',
      '',
      "Prefer a narrow regex that matches the problem and little else; write it in single quotes. If no regex can catch it, leave condition out and add question: '<a yes/no question about the final reply; yes means the rule was broken>'.",
      'Answer with the file alone inside <rule></rule> tags.',
    ].join('\n'),
    prompt: `The person's complaint about the assistant:\n${complaint}\n\nRecent conversation, oldest first:\n<conversation>\n${recent}\n</conversation>`,
  }
}

/** The last `<rule>…</rule>` block of a draft reply, trimmed. */
export function extractDraft(reply: string): string | undefined {
  const all = [...reply.matchAll(/<rule>([\s\S]*?)<\/rule>/g)]
  const last = all.at(-1)?.[1]?.trim()
  return last ? last : undefined
}

/** Recent conversation for a draft, newest kept when it must be cut. */
export function recentContext(messages: readonly { role: string; text: string }[]): string {
  const parts: string[] = []
  let size = 0
  for (const m of [...messages].reverse()) {
    if (m.text.trim() === '') continue
    const part = `[${m.role}] ${m.text}`
    if (size + part.length > DRAFT_CONTEXT_CHARS) {
      if (parts.length === 0) parts.push(part.slice(part.length - DRAFT_CONTEXT_CHARS))
      break
    }
    parts.push(part)
    size += part.length
  }
  return parts.reverse().join('\n\n')
}

export function statusText(config: Config, s: Session, rules: number, errors: number): string {
  const state = isActive(config, s) ? 'on' : 'off'
  const source = s.mode === null ? 'from the enabled option' : 'set for this session'
  const lines = [
    `${state} (${source}); ${rules} rules loaded, ${errors} ${errors === 1 ? 'file' : 'files'} failed; ${s.corrections} of ${config.maxCorrections} corrections used for this prompt.`,
  ]
  if (s.lastError) lines.push(`Last error: ${s.lastError}`)
  return lines.join('\n')
}

const scopeText = (r: RuleSpec) =>
  r.scope.map(s => (s.kind !== 'tool' ? s.kind : s.tool === undefined ? 'tool' : s.glob ? `tool:${s.tool}(${s.glob})` : `tool:${s.tool}`)).join(', ')

export function listText(rules: readonly RuleSpec[], errors: readonly LoadError[]): string {
  const lines: string[] = []
  if (rules.length === 0) lines.push('No rules loaded. Put rule files in ~/.claude/stream-rules/ or <project>/.claude/stream-rules/.')
  for (const r of rules) {
    const kind = r.question ? 'judged' : r.interrupt ? 'stops' : 'reminds'
    const off = r.enabled ? '' : ' [disabled]'
    lines.push(`${r.name}${off} (${r.source}, ${kind}; ${r.question ? 'the final answer' : scopeText(r)})${r.description ? `: ${r.description}` : ''}`)
    if (r.conditions.length > 0) lines.push(`  condition: ${r.conditions.join(' | ')}`)
    if (r.question) lines.push(`  question: ${r.question}`)
  }
  if (errors.length > 0) {
    lines.push('', 'Files that failed to load:')
    for (const e of errors) lines.push(`  ${e.path}: ${e.error}`)
  }
  return lines.join('\n')
}

/** `/stream-rules test`: which rules match a text as a reply. */
export function testText(rules: readonly Rule[], text: string): string {
  const lines: string[] = []
  for (const r of rules) {
    if (!r.enabled || !r.scope.some(s => s.kind === 'text') && r.question === undefined) continue
    const hit = r.regexes.some(re => re.test(text))
    if (r.question !== undefined) {
      if (r.regexes.length === 0) lines.push(`${r.name}: judged; no prefilter, the question would be asked`)
      else lines.push(`${r.name}: judged; prefilter ${hit ? 'matches, the question would be asked' : "doesn't match"}`)
    } else if (hit) lines.push(`${r.name}: matches (${r.interrupt ? 'stops the reply' : 'reminds'})`)
  }
  return lines.length > 0 ? lines.join('\n') : 'No rule matches that text.'
}
