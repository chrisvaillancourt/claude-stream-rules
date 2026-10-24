// Ownership of follow-up work, as one state machine. Pure: no `$`, no I/O.
//
// Every event that can change who owns a correction or a judgment goes
// through `transition`, inside one `update` of the session atom. It returns
// the new state and the actions to take; register.ts performs each action
// only after re-reading the state and finding its owner still current
// (`isCurrent`), and releases the action's claim when it is not.
import type { Claim, Config, Mode, Pending, RuleSpec, Session } from '../types'
import {
  INITIAL,
  canCorrect,
  contextText,
  correctionText,
  denyText,
  firedAt,
  isActive,
  isEligible,
  judgedText,
  loopKey,
  markFired,
  reminderText,
  stepsOf,
  bumpStep,
} from './policy'

/** A prompt entering the session, as `prompt.submit` describes it. */
export type Ingress = { origin: { kind: string; name?: string }; command?: { name: string }; isMeta?: boolean }

/** `supersede`: new work, older follow-ups are dropped. `preserve`: context for the work in hand. `ignore`: this mod's own commands. */
export type IngressClass = 'supersede' | 'preserve' | 'ignore'

const PRESERVE = new Set(['task-notification', 'peer', 'peer-send-message', 'observer', 'observer-activity'])

/**
 * Which prompts start new work. Unknown origins supersede: dropping a stale
 * correction is the safe direction.
 *
 * | Ingress | Class |
 * | --- | --- |
 * | `/stream-rules`, `/stream-rules-draft` | ignore (on/off has its own event) |
 * | any other slash command (skills and prompt commands start model work) | supersede |
 * | `composer`, `sdk`, `bridge`, `channel`, `slack-ping`, `coordinator`, `projects-relay`, `auto-continuation` | supersede |
 * | `scheduled-trigger` (scheduled tasks, `/loop`) | supersede |
 * | another plugin's `$.prompt.submit` | supersede |
 * | `unclassified` not marked meta | supersede |
 * | this mod's own corrective prompt | preserve |
 * | `task-notification`, `peer`, `peer-send-message`, `observer`, `observer-activity` | preserve |
 * | `unclassified` marked meta (idle notices, delivery receipts) | preserve |
 */
export function classifyIngress(i: Ingress): IngressClass {
  if (i.command !== undefined) return i.command.name === 'stream-rules' || i.command.name === 'stream-rules-draft' ? 'ignore' : 'supersede'
  const kind = i.origin.kind
  if (kind === 'plugin') return i.origin.name === 'stream-rules' ? 'preserve' : 'supersede'
  if (PRESERVE.has(kind)) return 'preserve'
  if (kind === 'unclassified') return i.isMeta ? 'preserve' : 'supersede'
  return 'supersede'
}

export type Event =
  | { kind: 'ingress'; ingress: Ingress }
  | { kind: 'turn-start'; turnId: string }
  | { kind: 'step'; agentId?: string }
  | { kind: 'match'; turnId: string; agentId?: string; hits: readonly RuleSpec[]; pendingId: string }
  | { kind: 'abort-result'; pendingId: string; ok: boolean; error?: string }
  | { kind: 'turn-complete'; turnId: string; reason: string; answer: string; hasJudged: boolean }
  | { kind: 'deliver-correction'; pendingId: string }
  | { kind: 'judge-result'; epoch: number; broken: readonly RuleSpec[] }
  | { kind: 'tool-match'; agentId?: string; hits: readonly RuleSpec[] }
  | { kind: 'release'; claim: Claim }
  | { kind: 'set-mode'; mode: Mode }
  | { kind: 'clear' }
  | { kind: 'reload' }

export type Action =
  | { kind: 'abort'; turnId: string; pendingId: string; epoch: number; claim: Claim }
  | { kind: 'remind'; agentId?: string; text: string; epoch: number; claim: Claim }
  | { kind: 'submit'; text: string; epoch: number; claim: Claim; label: string }
  | { kind: 'schedule-correction'; pendingId: string }
  | { kind: 'schedule-judge'; epoch: number; answer: string }
  | { kind: 'deny'; text: string; claim: Claim }
  | { kind: 'note'; text: string; claim: Claim }
  | { kind: 'log'; text: string }
  | { kind: 'error'; text: string }

export type Step = { state: Session; actions: Action[] }

/** Whether work owned by `epoch` may still be delivered: nothing superseded it and the mod is on. */
export function isCurrent(config: Config, s: Session, epoch: number): boolean {
  return s.epoch === epoch && isActive(config, s)
}

/** The main turn that is running belongs to the current epoch. */
function ownsTurn(s: Session, turnId: string): boolean {
  return s.turn !== null && s.turn.id === turnId && s.turn.epoch === s.epoch
}

function claim(s: Session, loop: string, names: readonly string[]): { state: Session; claim: Claim } {
  const prior: Record<string, number | null> = {}
  for (const n of names) prior[n] = firedAt(s, loop, n) ?? null
  return { state: markFired(s, loop, names), claim: { loop, at: stepsOf(s, loop), prior } }
}

/** Undoes a claim's marks that still hold the claimed value. */
export function release(s: Session, c: Claim): Session {
  const mine: Record<string, number> = { ...(Object.hasOwn(s.fired, c.loop) ? s.fired[c.loop] : {}) }
  let changed = false
  for (const [name, prior] of Object.entries(c.prior)) {
    if (!Object.hasOwn(mine, name) || mine[name] !== c.at) continue
    changed = true
    if (prior === null) delete mine[name]
    else mine[name] = prior
  }
  return changed ? { ...s, fired: { ...s.fired, [c.loop]: mine } } : s
}

function dropPending(s: Session, why: string): Step {
  if (s.pending === null) return { state: s, actions: [] }
  return {
    state: release({ ...s, pending: null }, s.pending.claim),
    actions: [{ kind: 'log', text: `dropped the correction for ${s.pending.rules.join(', ')} (${why})` }],
  }
}

const none = (s: Session): Step => ({ state: s, actions: [] })

export function transition(s: Session, ev: Event, config: Config): Step {
  switch (ev.kind) {
    case 'ingress': {
      if (classifyIngress(ev.ingress) !== 'supersede') return none(s)
      return dropPending({ ...s, epoch: s.epoch + 1, corrections: 0 }, 'a newer prompt arrived')
    }
    case 'set-mode':
      return dropPending({ ...s, mode: ev.mode, epoch: s.epoch + 1 }, `/stream-rules ${ev.mode}`)
    case 'clear':
      return { state: { ...INITIAL, mode: s.mode, epoch: s.epoch + 1 }, actions: [] }
    case 'reload':
      return dropPending(s, 'the mod reloaded before it was sent')
    case 'turn-start':
      return none({ ...s, turn: { id: ev.turnId, epoch: s.epoch } })
    case 'step':
      return none(bumpStep(s, loopKey(ev.agentId)))
    case 'release':
      return none(release(s, ev.claim))

    case 'match': {
      if (!isActive(config, s)) return none(s)
      const loop = loopKey(ev.agentId)
      const steps = stepsOf(s, loop)
      const eligible = ev.hits.filter(r => isEligible(r, 'prose', firedAt(s, loop, r.name), steps))
      if (eligible.length === 0) return none(s)
      const c = claim(s, loop, eligible.map(r => r.name))
      const canStop =
        ev.agentId === undefined && ownsTurn(s, ev.turnId) && s.pending === null && eligible.some(r => r.interrupt) && canCorrect(config, s)
      if (canStop) {
        const pending: Pending = {
          id: ev.pendingId,
          turnId: ev.turnId,
          epoch: s.epoch,
          rules: eligible.map(r => r.name),
          text: correctionText(eligible),
          reminder: reminderText(eligible),
          claim: c.claim,
          phase: 'aborting',
        }
        return {
          state: { ...c.state, corrections: s.corrections + 1, pending },
          actions: [{ kind: 'abort', turnId: ev.turnId, pendingId: ev.pendingId, epoch: s.epoch, claim: c.claim }],
        }
      }
      const remind: Action = { kind: 'remind', text: reminderText(eligible), epoch: s.epoch, claim: c.claim, ...(ev.agentId !== undefined ? { agentId: ev.agentId } : {}) }
      return { state: c.state, actions: [remind] }
    }

    case 'abort-result': {
      const p = s.pending
      if (p === null || p.id !== ev.pendingId) return none(s)
      if (ev.ok) return none({ ...s, pending: { ...p, phase: 'aborted' } })
      // The turn goes on: the withheld text is passed on and the rule becomes a reminder.
      return {
        state: { ...s, pending: null, corrections: Math.max(0, s.corrections - 1) },
        actions: [
          { kind: 'error', text: `could not stop the turn (${ev.error ?? 'refused'}); the reply went on and a reminder was added` },
          { kind: 'remind', text: p.reminder, epoch: p.epoch, claim: p.claim },
        ],
      }
    }

    case 'turn-complete': {
      if (s.pending !== null && s.pending.turnId === ev.turnId) return { state: s, actions: [{ kind: 'schedule-correction', pendingId: s.pending.id }] }
      if (ev.reason !== 'answer' || ev.answer.trim() === '' || !ev.hasJudged) return none(s)
      if (!isActive(config, s) || !ownsTurn(s, ev.turnId)) return none(s)
      return { state: s, actions: [{ kind: 'schedule-judge', epoch: s.epoch, answer: ev.answer }] }
    }

    case 'deliver-correction': {
      const p = s.pending
      if (p === null || p.id !== ev.pendingId) return none(s)
      if (!isCurrent(config, s, p.epoch)) return dropPending(s, 'superseded, or the mod is off')
      return {
        state: { ...s, pending: null },
        actions: [{ kind: 'submit', text: p.text, epoch: p.epoch, claim: p.claim, label: `the correction for ${p.rules.join(', ')}` }],
      }
    }

    case 'judge-result': {
      if (!isCurrent(config, s, ev.epoch)) return none(s)
      const steps = stepsOf(s, 'main')
      const eligible = ev.broken.filter(r => isEligible(r, 'prose', firedAt(s, 'main', r.name), steps))
      if (eligible.length === 0) return none(s)
      const c = claim(s, 'main', eligible.map(r => r.name))
      if (config.judgeAction === 'correct' && canCorrect(config, s)) {
        return {
          state: { ...c.state, corrections: s.corrections + 1 },
          actions: [{ kind: 'submit', text: judgedText(eligible, 'correct'), epoch: s.epoch, claim: c.claim, label: 'a judged correction' }],
        }
      }
      return { state: c.state, actions: [{ kind: 'remind', text: judgedText(eligible, 'remind'), epoch: s.epoch, claim: c.claim }] }
    }

    case 'tool-match': {
      if (!isActive(config, s)) return none(s)
      const loop = loopKey(ev.agentId)
      const steps = stepsOf(s, loop)
      let eligible = ev.hits.filter(r => isEligible(r, 'tool', firedAt(s, loop, r.name), steps))
      // Tool routing yields to an eligible ordinary refusal: one refusal, the
      // person's own rule, and routing isn't claimed. Decided after eligibility,
      // so a spent rule never suppresses routing.
      if (eligible.some(r => r.matcher === undefined && r.interrupt)) eligible = eligible.filter(r => r.matcher === undefined)
      if (eligible.length === 0) return none(s)
      const c = claim(s, loop, eligible.map(r => r.name))
      // A denial carries every claimed rule, so none is spent unseen.
      if (eligible.some(r => r.interrupt)) return { state: c.state, actions: [{ kind: 'deny', text: denyText(eligible), claim: c.claim }] }
      return { state: c.state, actions: [{ kind: 'note', text: contextText(eligible), claim: c.claim }] }
    }
  }
}
