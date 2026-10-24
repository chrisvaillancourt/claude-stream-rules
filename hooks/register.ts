import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnStepChunk } from 'claude-code'

import {
  DRAFT_CHECK_MESSAGES,
  DRAFT_USAGE,
  INITIAL,
  USAGE,
  canCorrect,
  configFrom,
  contextText,
  correctionText,
  denyText,
  draftPrompt,
  extractDraft,
  isActive,
  isEligible,
  judgePrompt,
  judgedText,
  listText,
  loopKey,
  markFired,
  bumpStep,
  parseArgs,
  parseDraftArgs,
  parseVerdict,
  recentContext,
  reminderText,
  statusText,
  testText,
} from './policy'
import { compile, matchText, matchTool, mergeRules, parseRule } from './rules'
import type { Rule } from './rules'
import type { Config, LoadError, RuleSource, RuleSpec } from '../types'

const NAME = 'stream-rules'

// Change a shape tag when its stored type changes: a value an older version
// stored (it outlives a hot reload) then reads as the initial value.
const sessionAtom = atom({ plugin: 'stream-rules', key: 'session' } as const, INITIAL, { shape: 'session-2' })
const pendingAtom = atom({ plugin: 'stream-rules', key: 'pending' } as const, null, { shape: 'pending-1' })
const draftAtom = atom({ plugin: 'stream-rules', key: 'draft' } as const, null, { shape: 'draft-1' })

// Module variables reset on a hot reload; register and session.start run again then.
let config: Config = configFrom({})
let rules: Rule[] = []
let loadErrors: LoadError[] = []
let cwd = ''
let home = ''
/** Bumped by /clear: timers started before it see a different value and stop. */
let generation = 0
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

async function appendReminder($: EngineInterface, text: string, agentId: string | undefined) {
  try {
    const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] }, ...(agentId !== undefined ? { agentId } : {}) })
    if (r.deny !== undefined) await recordError($, `a reminder was refused: ${r.deny}`)
  } catch (err) {
    await recordError($, `a reminder could not be added${agentId ? ` to agent ${agentId}` : ''}: ${errText(err)}`)
  }
}

type ProseDecision = { kind: 'none' } | { kind: 'remind'; rules: Rule[] } | { kind: 'stop'; rules: Rule[]; pendingId: string }

/** Claims the eligible rules among `hits` and decides: stop the turn, remind, or nothing. */
async function decideProse($: EngineInterface, turnId: string, agentId: string | undefined, hits: Rule[]): Promise<ProseDecision> {
  const loop = loopKey(agentId)
  let decision: ProseDecision = { kind: 'none' }
  const pendingId = `p${++counter}`
  await update($, sessionAtom, s => {
    const steps = s.steps[loop] ?? 0
    const eligible = hits.filter(r => isEligible(r, 'prose', s.fired[loop]?.[r.name], steps))
    if (eligible.length === 0) {
      decision = { kind: 'none' }
      return s
    }
    const fired = markFired(s, loop, eligible.map(r => r.name))
    const wantsStop = agentId === undefined && eligible.some(r => r.interrupt)
    if (wantsStop && canCorrect(config, s)) {
      decision = { kind: 'stop', rules: eligible, pendingId }
      return { ...fired, corrections: s.corrections + 1 }
    }
    decision = { kind: 'remind', rules: eligible }
    return fired
  })
  const d = decision as ProseDecision
  if (d.kind === 'stop') {
    await update($, pendingAtom, () => ({ id: pendingId, turnId, rules: d.rules.map(r => r.name), text: correctionText(d.rules) }))
  }
  return d
}

/** After a stopped turn ends: send the corrective prompt, unless the pending record was replaced or dropped. */
async function sendCorrection($: EngineInterface, id: string, gen: number) {
  if (gen !== generation) return
  const p = await read($, pendingAtom)
  if (p === null || p.id !== id) return
  await update($, pendingAtom, () => null)
  try {
    const r = await $.prompt.submit({ text: p.text })
    if (r.drop !== undefined) await recordError($, `the corrective prompt for ${p.rules.join(', ')} was dropped: ${r.drop}`)
    else log($, `sent a correction for ${p.rules.join(', ')}`)
  } catch (err) {
    await recordError($, `the corrective prompt for ${p.rules.join(', ')} failed: ${errText(err)}`)
  }
}

/** Judged rules, after a main-loop answer: ask each question, then remind (or correct) on a yes. */
async function judge($: EngineInterface, answer: string, gen: number) {
  const s0 = await read($, sessionAtom)
  const steps = s0.steps.main ?? 0
  const candidates = rules
    .filter(r => r.enabled && r.question !== undefined)
    .filter(r => isEligible(r, 'prose', s0.fired.main?.[r.name], steps))
    .filter(r => r.regexes.length === 0 || r.regexes.some(re => re.test(answer)))
    .slice(0, config.judgeMaxPerTurn)
  const broken: Rule[] = []
  for (const r of candidates) {
    const { system, prompt } = judgePrompt(r, answer)
    try {
      const res = await $.model.complete({ model: config.judgeModel, system, prompt, maxTokens: 64, effort: 'low', timeoutMs: 30_000 })
      if (gen !== generation) return
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
  if (broken.length === 0 || gen !== generation) return
  let claimed: Rule[] = []
  let correct = false
  await update($, sessionAtom, s => {
    const now = s.steps.main ?? 0
    claimed = broken.filter(r => isEligible(r, 'prose', s.fired.main?.[r.name], now))
    if (claimed.length === 0) return s
    correct = config.judgeAction === 'correct' && canCorrect(config, s)
    const fired = markFired(s, 'main', claimed.map(r => r.name))
    return correct ? { ...fired, corrections: s.corrections + 1 } : fired
  })
  if (claimed.length === 0) return
  if (correct) {
    try {
      const r = await $.prompt.submit({ text: judgedText(claimed, 'correct') })
      if (r.drop !== undefined) await recordError($, `a judged correction was dropped: ${r.drop}`)
    } catch (err) {
      await recordError($, `a judged correction failed: ${errText(err)}`)
    }
  } else await appendReminder($, judgedText(claimed, 'remind'), undefined)
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
  const recent = messages
    .filter(m => m.role === 'assistant' && m.text.trim() !== '')
    .slice(-DRAFT_CHECK_MESSAGES)
    .map(m => m.text)
  const hits = rule!.regexes.length === 0 ? undefined : recent.filter(t => rule!.regexes.some(re => re.test(t)))
  await update($, draftAtom, () => ({ name: parsed.rule.name, text }))
  const check =
    hits === undefined
      ? 'Judged rule (no condition): checked by the judge model after each answer.'
      : `Its condition matches ${hits.length} of the last ${recent.length} assistant messages${hits.length > 0 ? `, for example:\n  ${hits[hits.length - 1]!.slice(0, 160).replace(/\s+/g, ' ')}` : '.'}`
  const exists = rule!.name !== '' && rules.some(r => r.name === rule!.name) ? `\nA loaded rule is already named ${rule!.name}; saving over its file needs overwrite.` : ''
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
  const stale = await read($, pendingAtom)
  if (stale !== null) {
    await update($, pendingAtom, () => null)
    log($, `dropped a pending correction for ${stale.rules.join(', ')} (the mod reloaded before it was sent)`)
  }
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
      generation++
      await update($, sessionAtom, s => ({ ...INITIAL, mode: s.mode }))
      await update($, pendingAtom, () => null)
      await update($, draftAtom, () => null)
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const isOurs = e.origin.kind === 'plugin' && e.origin.name === NAME
    if (!isOurs && e.command === undefined) await update($, sessionAtom, s => (s.corrections === 0 ? s : { ...s, corrections: 0 }))
    return next(e)
  }).catch(($, e, next) => next(e)) // never hold up a prompt over the counter

  on('command.run', { command: 'stream-rules' }, async ($, e) => {
    const cmd = parseArgs(e.args)
    if (cmd.kind === 'help') return { text: cmd.error ? `${cmd.error}\n${USAGE}` : USAGE }
    if (cmd.kind === 'set') await update($, sessionAtom, s => ({ ...s, mode: cmd.mode }))
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
    if (!isActive(config, await read($, sessionAtom))) return next(e)
    const loop = loopKey(e.agentId)
    let eligible: Rule[] = []
    await update($, sessionAtom, s => {
      const steps = s.steps[loop] ?? 0
      eligible = hits.filter(r => isEligible(r, 'tool', s.fired[loop]?.[r.name], steps))
      return eligible.length === 0 ? s : markFired(s, loop, eligible.map(r => r.name))
    })
    if (eligible.length === 0) return next(e)
    const stop = eligible.filter(r => r.interrupt)
    if (stop.length > 0) {
      log($, `refused ${String(e.tool)} (${stop.map(r => r.name).join(', ')})`)
      return { deny: denyText(stop) }
    }
    const r = await next(e)
    if (r.deny !== undefined) return r
    return { ...r, context: [...(r.context ?? []), contextText(eligible)] }
  }).catch(async ($, e, next) => {
    // Fail open: rules are guidance, not a security boundary, and a broken
    // rule must not block every tool. The error shows in /stream-rules status.
    await recordError($, `the tool guard failed on ${String(e.tool)}; the call ran unchecked`).catch(ignore)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const watched = rules.some(r => r.enabled && r.question === undefined && r.scope.some(s => s.kind !== 'tool'))
    const s0 = await read($, sessionAtom)
    if (!isActive(config, s0)) return yield* next(e)
    const loop = loopKey(e.agentId)
    await update($, sessionAtom, s => bumpStep(s, loop))
    if (!watched) return yield* next(e)
    const pending = await read($, pendingAtom)
    if (pending !== null && pending.turnId === e.turnId) return yield* next(e)

    const stream = next(e)
    const buffers = new Map<string, string>()
    const handled = new Set<string>()
    let withheld: TurnStepChunk[] | null = null
    let aborted: Promise<boolean> | null = null
    let abortFailed = false
    for await (const c of stream) {
      if (withheld !== null) {
        if (!abortFailed) {
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
          const d = await decideProse($, e.turnId, e.agentId, hits)
          if (d.kind === 'remind') await appendReminder($, reminderText(d.rules), e.agentId)
          if (d.kind === 'stop') {
            log($, `stopped the reply (${d.rules.map(r => r.name).join(', ')})`)
            withheld = [c]
            aborted = $.turn.abort({ turnId: e.turnId }).then(
              () => true,
              async (err: unknown) => {
                abortFailed = true
                await update($, pendingAtom, p => (p?.id === d.pendingId ? null : p))
                await recordError($, `could not stop the turn (${errText(err)}); the reply went on and a reminder was added`)
                await appendReminder($, reminderText(d.rules), undefined)
                return false
              },
            )
            continue
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
    const gen = generation
    const p = await read($, pendingAtom)
    if (p !== null && p.turnId === e.turnId) {
      const id = p.id
      $.clock.after(0, () => sendCorrection($, id, gen))
    } else if (e.reason === 'answer' && e.answer.trim() !== '' && rules.some(r => r.enabled && r.question !== undefined)) {
      if (isActive(config, await read($, sessionAtom))) {
        const answer = e.answer
        $.clock.after(0, () => judge($, answer, gen).catch(err => log($, `judging failed: ${errText(err)}`)))
      }
    }
    return next(e)
  })
}
