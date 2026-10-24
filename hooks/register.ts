import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnStepChunk } from 'claude-code'

import { isCurrent, transition } from './lifecycle'
import type { Action, Event } from './lifecycle'
import {
  DRAFT_USAGE,
  INITIAL,
  USAGE,
  configFrom,
  draftCheck,
  draftPrompt,
  extractDraft,
  firedAt,
  isActive,
  isEligible,
  judgePrompt,
  listText,
  parseArgs,
  parseDraftArgs,
  parseVerdict,
  recentContext,
  stepsOf,
  statusText,
  testText,
} from './policy'
import { compile, matchText, matchTool, mergeRules, parseRule } from './rules'
import type { Rule } from './rules'
import type { Claim, Config, LoadError, RuleSource, RuleSpec, Session } from '../types'

const NAME = 'stream-rules'

// Change a shape tag when its stored type changes: a value an older version
// stored (it outlives a hot reload) then reads as the initial value.
const sessionAtom = atom({ plugin: 'stream-rules', key: 'session' } as const, INITIAL, { shape: 'session-4' })
const draftAtom = atom({ plugin: 'stream-rules', key: 'draft' } as const, null, { shape: 'draft-1' })

// Module variables reset on a hot reload; register and session.start run again then.
let config: Config = configFrom({})
let rules: Rule[] = []
let loadErrors: LoadError[] = []
let cwd = ''
let home = ''
let counter = 0

/** Best effort: reporting must never throw out of a hook or a timer. */
function log($: EngineInterface, text: string) {
  try {
    $.ui.log(`${NAME}: ${text}`)
  } catch {
    // nothing to do
  }
}

async function recordError($: EngineInterface, text: string) {
  log($, text)
  try {
    await update($, sessionAtom, s => ({ ...s, lastError: text }))
  } catch {
    // nothing to do
  }
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

function ruleDirs(): { dir: string; source: RuleSource }[] {
  const user = { dir: `${home}/.claude/stream-rules`, source: 'user' as const }
  const project = { dir: `${cwd}/.claude/stream-rules`, source: 'project' as const }
  return home !== '' && project.dir === user.dir ? [user] : [user, project].filter(d => !d.dir.startsWith('/.claude'))
}

async function loadRules($: EngineInterface) {
  const specs: RuleSpec[] = []
  const errors: LoadError[] = []
  for (const { dir, source } of ruleDirs()) {
    let names: string[] = []
    try {
      if (!(await $.fs.exists(dir))) continue
      names = (await $.fs.list(dir))
        .filter(e => e.kind !== 'dir' && e.name.toLowerCase().endsWith('.md'))
        .map(e => e.name)
        .sort()
    } catch (err) {
      errors.push({ path: dir, error: `could not list: ${errText(err)}` })
      continue
    }
    for (const name of names) {
      const path = `${dir}/${name}`
      try {
        const r = parseRule(await $.fs.read(path), name, source, path)
        if ('error' in r) errors.push({ path, error: r.error })
        else specs.push(r.rule)
      } catch (err) {
        errors.push({ path, error: `could not read: ${errText(err)}` })
      }
    }
  }
  rules = compile(mergeRules(specs))
  loadErrors = errors
  if (errors.length > 0) log($, `${errors.length} rule file(s) failed to load; /stream-rules list shows why`)
}


// --- Ownership: every change goes through lifecycle.transition in one update;
// every externally visible action re-reads the state first (stillCurrent).

/** Runs one lifecycle event atomically and returns the actions it asks for. */
async function dispatch($: EngineInterface, ev: Event): Promise<Action[]> {
  let actions: Action[] = []
  await update($, sessionAtom, s => {
    const r = transition(s, ev, config)
    actions = r.actions
    return r.state
  })
  return actions
}

/**
 * Asks the session, right before an action, whether `test` still holds. It
 * goes through `update` (a versioned write of the same value), not a plain
 * read: a read can still hold this module's own earlier write when another
 * hook's later write has landed, and a versioned write retries on that miss.
 */
async function confirm($: EngineInterface, test: (s: Session) => boolean): Promise<boolean> {
  let ok = false
  await update($, sessionAtom, s => {
    ok = test(s)
    return s
  })
  return ok
}

/** May work owned by `epoch` still act? Checked after every await, before each action. */
async function stillCurrent($: EngineInterface, epoch: number): Promise<boolean> {
  return confirm($, s => isCurrent(config, s, epoch))
}

/** An undelivered claim is released, so the rule isn't spent unseen. */
async function releaseClaim($: EngineInterface, claim: Claim, why: string) {
  await dispatch($, { kind: 'release', claim })
  log($, `${why}; nothing delivered`)
}

async function deliverReminder($: EngineInterface, a: Extract<Action, { kind: 'remind' }>) {
  if (!(await stillCurrent($, a.epoch))) return releaseClaim($, a.claim, 'a reminder lost its owner (newer prompt, off or /clear)')
  try {
    const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: a.text }] }, ...(a.agentId !== undefined ? { agentId: a.agentId } : {}) })
    if (r.deny === undefined) return
    await recordError($, `a reminder was refused: ${r.deny}`)
  } catch (err) {
    await recordError($, `a reminder could not be added${a.agentId ? ` to agent ${a.agentId}` : ''}: ${errText(err)}`)
  }
  await dispatch($, { kind: 'release', claim: a.claim })
}

async function deliverSubmit($: EngineInterface, a: Extract<Action, { kind: 'submit' }>) {
  if (!(await stillCurrent($, a.epoch))) return releaseClaim($, a.claim, `${a.label} lost its owner (newer prompt, off or /clear)`)
  try {
    const r = await $.prompt.submit({ text: a.text })
    if (r.drop === undefined) return log($, `sent ${a.label}`)
    await recordError($, `${a.label} was dropped: ${r.drop}`)
  } catch (err) {
    await recordError($, `${a.label} failed: ${errText(err)}`)
  }
  await dispatch($, { kind: 'release', claim: a.claim })
}

/** Performs the actions that need no stream or tool call of their own; `abort`, `deny` and `note` are the caller's. */
async function perform($: EngineInterface, actions: readonly Action[]) {
  for (const a of actions) {
    if (a.kind === 'log') log($, a.text)
    else if (a.kind === 'error') await recordError($, a.text)
    else if (a.kind === 'remind') await deliverReminder($, a)
    else if (a.kind === 'submit') await deliverSubmit($, a)
    else if (a.kind === 'schedule-correction') {
      const id = a.pendingId
      $.clock.after(0, () => correctionDue($, id))
    } else if (a.kind === 'schedule-judge') {
      const { answer, epoch } = a
      $.clock.after(0, () => judge($, answer, epoch).catch(err => log($, `judging failed: ${errText(err)}`)))
    }
  }
}

async function correctionDue($: EngineInterface, pendingId: string) {
  await perform($, await dispatch($, { kind: 'deliver-correction', pendingId }))
}

/** Judged rules, after a main-loop answer: ask each question, then hand the yeses to the lifecycle. */
async function judge($: EngineInterface, answer: string, epoch: number) {
  const s0 = await read($, sessionAtom)
  if (!isCurrent(config, s0, epoch)) return
  const steps = stepsOf(s0, 'main')
  const candidates = rules
    .filter(r => r.enabled && r.question !== undefined)
    .filter(r => isEligible(r, 'prose', firedAt(s0, 'main', r.name), steps))
    .filter(r => r.regexes.length === 0 || r.regexes.some(re => re.test(answer)))
    .slice(0, config.judgeMaxPerTurn)
  const broken: RuleSpec[] = []
  for (const r of candidates) {
    const { system, prompt } = judgePrompt(r, answer)
    try {
      const res = await $.model.complete({ model: config.judgeModel, system, prompt, maxTokens: 64, effort: 'low', timeoutMs: 30_000 })
      if (!(await stillCurrent($, epoch))) return log($, 'dropped a judgment (newer prompt, off or /clear)')
      if (!res.isAnswered) {
        log($, `judging ${r.name} failed (${res.reason}); nothing delivered`)
        continue
      }
      const v = parseVerdict(res.text)
      log($, v === undefined ? `judging ${r.name}: unclear verdict; nothing delivered` : `judged ${r.name}: ${v}`)
      if (v === 'yes') broken.push(r)
    } catch (err) {
      log($, `judging ${r.name} failed: ${errText(err)}`)
    }
  }
  if (broken.length === 0) return
  await perform($, await dispatch($, { kind: 'judge-result', epoch, broken }))
}

async function runDraft($: EngineInterface, complaint: string): Promise<string> {
  const messages = await $.session.messages()
  const { system, prompt } = draftPrompt(complaint, recentContext(messages.slice(-40)))
  const res = await $.model.complete({ model: config.draftModel, system, prompt, maxTokens: 1500, timeoutMs: 90_000 })
  if (!res.isAnswered) return `The draft model gave no answer (${res.reason}). Nothing was drafted.`
  const text = extractDraft(res.text)
  if (text === undefined) return "The draft model didn't return a rule. Try rewording the complaint."
  const parsed = parseRule(text, 'draft.md', 'project', '(draft)')
  if ('error' in parsed) {
    await update($, draftAtom, () => null)
    return `The draft doesn't load: ${parsed.error}. It isn't held; try again.\n\n${text}`
  }
  const [rule] = compile([parsed.rule])
  await update($, draftAtom, () => ({ name: parsed.rule.name, text }))
  const check = draftCheck(rule!, messages)
  const exists = rules.some(r => r.name === rule!.name) ? `\nA loaded rule is already named ${rule!.name}; saving over its file needs overwrite.` : ''
  return `Draft rule ${parsed.rule.name}:\n\n${text}\n\n${check}${exists}\n\nRun /stream-rules-draft save (project) or save user to write it, or cancel.`
}

async function saveDraft($: EngineInterface, dest: 'project' | 'user', overwrite: boolean): Promise<string> {
  const draft = await read($, draftAtom)
  if (draft === null) return 'No draft is held. Run /stream-rules-draft <complaint> first.'
  const parsed = parseRule(draft.text, `${draft.name}.md`, dest, '(draft)')
  if ('error' in parsed) return `The held draft doesn't load: ${parsed.error}`
  const dir = dest === 'user' ? `${home}/.claude/stream-rules` : `${cwd}/.claude/stream-rules`
  const path = `${dir}/${draft.name}.md`
  if (!overwrite && (await $.fs.exists(path))) return `${path} already exists. Run /stream-rules-draft save ${dest} overwrite to replace it.`
  await $.fs.write(path, `${draft.text}\n`)
  await update($, draftAtom, () => null)
  await loadRules($)
  return `Saved ${path}. ${rules.length} rules loaded.`
}

async function startSession($: EngineInterface, sessionCwd: string) {
  cwd = sessionCwd.replace(/\/+$/, '')
  home = ((await $.env.get('HOME')) ?? '').replace(/\/+$/, '')
  // Timers died with the old module: a pending correction can't be sent now.
  await perform($, await dispatch($, { kind: 'reload' }))
  await loadRules($)
}

const ignore = () => undefined

export const register: Register = (on, options) => {
  config = configFrom(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'stream-rules', description: 'Show, test or switch the stream rules for this session', argumentHint: '[status|list|test <text>|on|off|reload|reset]' })
    await $.command.register({ name: 'stream-rules-draft', description: 'Draft a stream rule from a complaint; writes it only on save', argumentHint: '<complaint> | show | save [project|user] [overwrite] | cancel' })
    try {
      await startSession($, e.cwd)
    } catch (err) {
      await recordError($, `could not load rules: ${errText(err)}`)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await dispatch($, { kind: 'clear' })
      await update($, draftAtom, () => null)
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const origin = e.origin.kind === 'plugin' ? { kind: 'plugin', name: e.origin.name } : { kind: e.origin.kind }
    await perform($, await dispatch($, { kind: 'ingress', ingress: { origin, ...(e.command ? { command: { name: e.command.name } } : {}), ...(e.isMeta ? { isMeta: true } : {}) } }))
    return next(e)
  }).catch(($, e, next) => next(e)) // never hold up a prompt over bookkeeping

  on('command.run', { command: 'stream-rules' }, async ($, e) => {
    const cmd = parseArgs(e.args)
    if (cmd.kind === 'help') return { text: cmd.error ? `${cmd.error}\n${USAGE}` : USAGE }
    if (cmd.kind === 'set') await perform($, await dispatch($, { kind: 'set-mode', mode: cmd.mode }))
    if (cmd.kind === 'reload') await loadRules($)
    if (cmd.kind === 'reset') await update($, sessionAtom, s => ({ ...s, fired: {}, lastError: null }))
    if (cmd.kind === 'list') return { text: listText(rules, loadErrors) }
    if (cmd.kind === 'test') return { text: testText(rules, cmd.text) }
    return { text: statusText(config, await read($, sessionAtom), rules.length, loadErrors.length) }
  })

  on('command.run', { command: 'stream-rules-draft' }, async ($, e) => {
    const cmd = parseDraftArgs(e.args)
    if (cmd.kind === 'cancel') {
      await update($, draftAtom, () => null)
      return { text: 'Draft discarded.' }
    }
    if (cmd.kind === 'show') {
      const d = await read($, draftAtom)
      return { text: d === null ? `No draft is held.\n${DRAFT_USAGE}` : `Draft rule ${d.name}:\n\n${d.text}` }
    }
    if (cmd.kind === 'save') return { text: await saveDraft($, cmd.dest, cmd.overwrite) }
    return { text: await runDraft($, cmd.complaint) }
  })

  on('tool.call', async ($, e, next) => {
    if (rules.length === 0) return next(e)
    const hits = matchTool(rules, String(e.tool), e)
    if (hits.length === 0) return next(e)
    const actions = await dispatch($, { kind: 'tool-match', ...(e.agentId !== undefined ? { agentId: e.agentId } : {}), hits })
    const a = actions.find(x => x.kind === 'deny' || x.kind === 'note')
    if (a === undefined || (a.kind !== 'deny' && a.kind !== 'note')) return next(e)
    // Re-read after the claim: off may have landed meanwhile. A tool rule acts
    // on the call in hand, so it needs the mod on, not a particular epoch.
    if (!(await confirm($, s => isActive(config, s)))) {
      await dispatch($, { kind: 'release', claim: a.claim })
      return next(e)
    }
    if (a.kind === 'deny') {
      log($, `refused ${String(e.tool)}`)
      return { deny: a.text }
    }
    const r = await next(e)
    if (r.deny !== undefined) return r
    return { ...r, context: [...(r.context ?? []), a.text] }
  }).catch(async ($, e, next) => {
    // Fail open: rules are guidance, not a security boundary, and a broken
    // rule must not block every tool. The error shows in /stream-rules status.
    await recordError($, `the tool guard failed on ${String(e.tool)}; the call ran unchecked`).catch(ignore)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await dispatch($, { kind: 'turn-start', turnId: e.turnId })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!isActive(config, await read($, sessionAtom))) return yield* next(e)
    await dispatch($, { kind: 'step', ...(e.agentId !== undefined ? { agentId: e.agentId } : {}) })
    const watched = rules.some(r => r.enabled && r.question === undefined && r.scope.some(s => s.kind !== 'tool'))
    if (!watched) return yield* next(e)
    if ((await read($, sessionAtom)).pending?.turnId === e.turnId) return yield* next(e)

    const stream = next(e)
    const buffers = new Map<string, string>()
    const handled = new Set<string>()
    let withheld: TurnStepChunk[] | null = null
    let aborted: Promise<boolean> | null = null
    let resume = false
    for await (const c of stream) {
      if (withheld !== null) {
        if (!resume) {
          withheld.push(c)
          continue
        }
        for (const w of withheld) yield w
        withheld = null
      }
      if (c.kind === 'text' || c.kind === 'thinking') {
        const key = `${c.kind}:${c.index}`
        const buf = (buffers.get(key) ?? '') + c.text
        buffers.set(key, buf)
        const hits = matchText(rules, c.kind, buf).filter(r => !handled.has(r.name))
        if (hits.length > 0) {
          for (const h of hits) handled.add(h.name)
          const actions = await dispatch($, { kind: 'match', turnId: e.turnId, ...(e.agentId !== undefined ? { agentId: e.agentId } : {}), hits, pendingId: `p${++counter}` })
          await perform($, actions)
          const stop = actions.find(x => x.kind === 'abort')
          if (stop !== undefined && stop.kind === 'abort') {
            // Last check before the abort: the claim's await may have let a newer prompt or off land.
            const owned = await confirm($, s => s.pending?.id === stop.pendingId && isCurrent(config, s, stop.epoch))
            if (!owned) {
              await releaseClaim($, stop.claim, 'a stop lost its owner before the abort')
            } else {
              log($, 'stopped the reply')
              withheld = [c]
              const pendingId = stop.pendingId
              aborted = $.turn.abort({ turnId: e.turnId }).then(
                async () => {
                  await perform($, await dispatch($, { kind: 'abort-result', pendingId, ok: true }))
                  return true
                },
                async (err: unknown) => {
                  resume = true
                  await perform($, await dispatch($, { kind: 'abort-result', pendingId, ok: false, error: errText(err) }))
                  return false
                },
              )
              continue
            }
          }
        }
      }
      yield c
    }
    if (withheld !== null && aborted !== null && !(await aborted)) {
      for (const w of withheld) yield w
    }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const hasJudged = rules.some(r => r.enabled && r.question !== undefined)
    await perform($, await dispatch($, { kind: 'turn-complete', turnId: e.turnId, reason: e.reason, answer: e.answer, hasJudged }))
    return next(e)
  })
}
