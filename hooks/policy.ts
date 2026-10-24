// Pure decisions and text: no `$`, no I/O. register.ts wires them to events.
import type { Config, LoadError, Mode, RoutingStats, RuleSpec, Session } from '../types'
import type { Classification } from './bash'
import { isRouting, matchText, matchTool, matchToolCall, projectTool, targetOf } from './rules'
import type { Rule } from './rules'

export const NO_ROUTING: RoutingStats = { unsupported: 0, limit: 0, bypassed: 0, lastReason: null }

export const INITIAL: Session = { mode: null, corrections: 0, lastError: null, fired: {}, steps: {}, epoch: 0, turn: null, pending: null, routing: NO_ROUTING }

/** The Bash `description` prefix that skips tool routing for one call. */
export const BYPASS_PREFIX = '[tool-routing bypass] '
/** The longest bypass reason accepted, in characters. */
export const BYPASS_MAX_REASON = 240

/** Whether a tool call's input asks to skip tool routing: the exact prefix, then a nonempty reason of at most 240 characters. */
export function isBypass(input: unknown): boolean {
  const d = typeof input === 'object' && input !== null ? (input as { description?: unknown }).description : undefined
  if (typeof d !== 'string' || !d.startsWith(BYPASS_PREFIX)) return false
  const reason = d.slice(BYPASS_PREFIX.length).trim()
  return reason.length > 0 && reason.length <= BYPASS_MAX_REASON
}

/** Counts one routing diagnostic. `reason` is the matcher's syntax name, never command text. */
export function noteRouting(s: Session, kind: 'unsupported' | 'limit' | 'bypassed', reason?: string): Session {
  const r = s.routing
  if (kind === 'bypassed') return { ...s, routing: { ...r, bypassed: r.bypassed + 1 } }
  if (kind === 'limit') return { ...s, routing: { ...r, limit: r.limit + 1 } }
  return { ...s, routing: { ...r, unsupported: r.unsupported + 1, lastReason: reason ?? null } }
}

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
    toolRouting: options.toolRouting === true,
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
  | { kind: 'test-tool'; command: string }
  | { kind: 'help'; error?: string }

export const USAGE = 'Usage: /stream-rules [status|list|test <text>|test-tool Bash <command>|on|off|reload|reset]'

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
  if (word === 'test-tool') {
    const m = /^\S+\s+(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed)
    const tool = m?.[1]
    const command = m?.[2]?.trim() ?? ''
    if (tool === undefined) return { kind: 'help', error: 'test-tool needs a command: /stream-rules test-tool Bash <command>' }
    if (tool.toLowerCase() !== 'bash') return { kind: 'help', error: 'test-tool checks Bash commands only: /stream-rules test-tool Bash <command>' }
    if (command === '') return { kind: 'help', error: 'test-tool needs a command: /stream-rules test-tool Bash <command>' }
    return { kind: 'test-tool', command }
  }
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

// Rule names and agent ids are keys of plain objects in $.state: read them as
// own properties only, so a rule named `constructor` or `toString` is not
// mistaken for one that already fired. Computed keys define own properties,
// `__proto__` included.
const own = <T>(o: Record<string, T>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined)

/** Model responses seen in a loop. */
export function stepsOf(s: Session, loop: string): number {
  return own(s.steps, loop) ?? 0
}

/** The response count at which a rule last fired in a loop; undefined when it never has. */
export function firedAt(s: Session, loop: string, name: string): number | undefined {
  const mine = own(s.fired, loop)
  return mine === undefined ? undefined : own(mine, name)
}

export function bumpStep(s: Session, loop: string): Session {
  return { ...s, steps: { ...s.steps, [loop]: stepsOf(s, loop) + 1 } }
}

export function markFired(s: Session, loop: string, names: readonly string[]): Session {
  const at = stepsOf(s, loop)
  let mine: Record<string, number> = { ...(own(s.fired, loop) ?? {}) }
  for (const n of names) mine = { ...mine, [n]: at }
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

const ROUTE_LABEL: Record<string, string> = { 'bash-native-read': 'read', 'bash-native-edit': 'edit', 'bash-native-search': 'search', 'bash-native-files': 'file' }

/** Whether a routing rule's target tool is in the session's tool list (`null`: the list failed, so no). */
export const targetAvailable = (r: RuleSpec, tools: readonly string[] | null): boolean => r.matcher === undefined || (tools !== null && tools.includes(targetOf(r.matcher)))

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Tool routing's lines for `/stream-rules status`. `tools`: the session's tool names, or null when listing failed. */
export function routingStatusText(config: Config, s: Session, rules: readonly RuleSpec[], tools: readonly string[] | null): string {
  const routing = rules.filter(isRouting)
  const head = `Tool routing: ${config.toolRouting ? 'on' : 'off'} (toolRouting option)`
  if (routing.length === 0) return config.toolRouting ? `${head}, but no routing rule is loaded.` : `${head}.`
  const lines = [config.toolRouting ? `${head}.` : `${head}; your own routing rules still apply.`]
  const enabled = routing.filter(r => r.enabled)
  const active = enabled.filter(r => targetAvailable(r, tools))
  const names = active.length === 0 ? 'none' : active.map(r => `${r.name} (${targetOf(r.matcher!)})`).join(', ')
  // Configured and available is not acting: the off switch (session or option) stops every rule.
  lines.push(isActive(config, s) ? `  active: ${names}` : `  configured, not acting while stream-rules is off: ${names}`)
  if (tools === null) lines.push('  could not list the tools, so no routing rule is acting')
  else {
    for (const r of enabled.filter(x => !targetAvailable(x, tools))) {
      lines.push(`  ${targetOf(r.matcher!)} tool not available on this Claude Code; ${ROUTE_LABEL[r.matcher!]} routing off`)
    }
  }
  for (const r of routing.filter(x => !x.enabled)) lines.push(`  ${r.name}: disabled (${r.source})`)
  const st = s.routing
  const counts: string[] = []
  if (st.unsupported > 0) counts.push(`${plural(st.unsupported, 'Bash call', 'Bash calls')} not analyzed (last: ${st.lastReason ?? 'unknown'})`)
  if (st.limit > 0) counts.push(`${st.limit} over the size limit`)
  if (st.bypassed > 0) counts.push(`${st.bypassed} bypassed`)
  if (counts.length > 0) lines.push(`  this conversation: ${counts.join(', ')}`)
  return lines.join('\n')
}

const analysisText = (a: Classification | undefined): string => {
  if (a === undefined) return 'Matcher: no routing rule is loaded, so it did not run'
  if (a.kind !== 'supported') return `Matcher: not analyzed (${a.reason}); routing lets it run`
  return a.families.length > 0 ? `Matcher: understood; routes ${a.families.join(', ')}` : 'Matcher: understood; nothing in it is routed'
}

/** `/stream-rules test-tool Bash <command>`: what the matcher makes of it, which rules match, and the outcome. Repeat state and the bypass are left out. */
export function testToolText(rules: readonly Rule[], command: string, tools: readonly string[] | null, enforcing: boolean): string {
  const { hits, analysis } = matchToolCall(rules, 'Bash', { command })
  const lines = [analysisText(analysis)]
  for (const h of hits) {
    const does = h.interrupt ? 'refuses' : 'adds a note'
    if (!enforcing) lines.push(`${h.name}: matches, but enforcement is off (it ${does} once stream-rules is on)`)
    else if (h.matcher === undefined) lines.push(`${h.name}: matches; ${does}`)
    else if (targetAvailable(h, tools)) lines.push(`${h.name}: matches; ${does} and points to ${targetOf(h.matcher)}`)
    else lines.push(`${h.name}: matches, but this session has no ${targetOf(h.matcher)} tool, so it doesn't act`)
  }
  if (!enforcing) {
    lines.push('Would run: stream-rules is off for this session.')
    return lines.join('\n')
  }
  const acting = hits.filter(h => targetAvailable(h, tools))
  const ordinaryStops = acting.filter(h => h.matcher === undefined && h.interrupt)
  const refusers = ordinaryStops.length > 0 ? ordinaryStops : acting.filter(h => h.interrupt)
  if (refusers.length > 0) lines.push(`Would be refused by ${refusers.map(h => h.name).join(', ')}.`)
  else if (acting.length > 0) lines.push(`Would run, with a note from ${acting.map(h => h.name).join(', ')}.`)
  else lines.push('Would run.')
  lines.push('(Repeat state and the bypass are not considered.)')
  return lines.join('\n')
}

const scopeText = (r: RuleSpec) =>
  r.scope.map(s => (s.kind !== 'tool' ? s.kind : s.tool === undefined ? 'tool' : s.glob ? `tool:${s.tool}(${s.glob})` : `tool:${s.tool}`)).join(', ')

export function listText(rules: readonly RuleSpec[], errors: readonly LoadError[]): string {
  const lines: string[] = []
  if (rules.length === 0) lines.push('No rules loaded. Put rule files in ~/.claude/stream-rules/ or <project>/.claude/stream-rules/, or turn on the toolRouting option.')
  for (const r of rules) {
    const kind = r.matcher ? (r.interrupt ? 'routes' : 'routes, as a note') : r.question ? 'judged' : r.interrupt ? 'stops' : 'reminds'
    const off = r.enabled ? '' : ' [disabled]'
    lines.push(`${r.name}${off} (${r.source}, ${kind}; ${r.question ? 'the final answer' : scopeText(r)})${r.description ? `: ${r.description}` : ''}`)
    if (r.matcher) lines.push(`  matcher: ${r.matcher}, points to ${targetOf(r.matcher)}`)
    if (r.source === 'bundled') lines.push(...r.body.split('\n').map(l => `  | ${l}`))
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

type HistoryMessage = { role: string; text: string; toolUses: readonly { tool: string; input: unknown }[] }

const example = (t: string) => `\n  for example: ${t.replace(/\s+/g, ' ').slice(0, 160)}`

/**
 * How a draft would have fired on recent history, through the same matchers
 * live enforcement uses: replies for text scope, recorded tool calls (their
 * inputs projected as at a live call) for tool scope. History keeps no
 * streamed thinking, so a thinking scope is reported as not checked.
 */
export function draftCheck(rule: Rule, messages: readonly HistoryMessage[]): string {
  const assistant = messages.filter(m => m.role === 'assistant').slice(-DRAFT_CHECK_MESSAGES)
  const replies = assistant.map(m => m.text).filter(t => t.trim() !== '')
  if (rule.question !== undefined) {
    if (rule.regexes.length === 0) return 'Judged rule with no condition: the judge model checks each final answer; nothing here to test it on.'
    const hits = replies.filter(t => rule.regexes.some(re => re.test(t)))
    return `Judged rule: its condition (the prefilter) matches ${hits.length} of the last ${replies.length} assistant replies.${hits.length > 0 ? example(hits.at(-1)!) : ''}`
  }
  const lines: string[] = []
  if (rule.scope.some(s => s.kind === 'text')) {
    const hits = replies.filter(t => matchText([rule], 'text', t).length > 0)
    lines.push(`Reply scope: matches ${hits.length} of the last ${replies.length} assistant replies.${hits.length > 0 ? example(hits.at(-1)!) : ''}`)
  }
  if (rule.scope.some(s => s.kind === 'tool')) {
    const calls = assistant.flatMap(m => m.toolUses)
    const hits = calls.filter(c => matchTool([rule], c.tool, c.input).length > 0)
    const last = hits.at(-1)
    lines.push(
      `Tool scope: matches ${hits.length} of the last ${calls.length} tool calls.${last ? example(`${last.tool}: ${projectTool(last.tool, last.input).text}`) : ''}`,
    )
  }
  if (rule.scope.some(s => s.kind === 'thinking')) lines.push('Thinking scope: not checked; the conversation history keeps no streamed thinking.')
  return lines.join('\n')
}
