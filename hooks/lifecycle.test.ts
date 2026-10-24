import { describe, expect, test } from 'claude-code/testing'

import { classifyIngress, isCurrent, release, transition } from './lifecycle'
import type { Action, Event } from './lifecycle'
import { INITIAL, configFrom, firedAt } from './policy'
import { parseRule } from './rules'
import type { RuleSpec, Session } from '../types'

const config = configFrom({})

const spec = (front: string, name: string): RuleSpec => {
  const r = parseRule(`---\n${front}\n---\nMessage for ${name}.\n`, `${name}.md`, 'user', `/r/${name}.md`)
  if ('error' in r) throw new Error(r.error)
  return r.rule
}
const STOP = spec("condition: 'x'", 'stop')
const SOFT = spec("condition: 'x'\ninterrupt: false", 'soft')
const JUDGED = spec('question: Broken?', 'judged')

/** Runs events in order from INITIAL; returns the final state and every action, tagged by event index. */
function run(events: Event[], from: Session = INITIAL, cfg = config) {
  let s = from
  const actions: [number, Action][] = []
  events.forEach((ev, i) => {
    const r = transition(s, ev, cfg)
    s = r.state
    for (const a of r.actions) actions.push([i, a])
  })
  return { s, actions, kinds: actions.map(([i, a]) => `${i}:${a.kind}`) }
}

const ingress = (kind: string, extra: Record<string, unknown> = {}): Event => ({ kind: 'ingress', ingress: { origin: { kind, ...extra } } })
const command = (name: string): Event => ({ kind: 'ingress', ingress: { origin: { kind: 'composer' }, command: { name } } })
const start: Event = { kind: 'turn-start', turnId: 't1' }
const match = (hits: RuleSpec[], agentId?: string): Event => ({ kind: 'match', turnId: 't1', hits, pendingId: 'p1', ...(agentId ? { agentId } : {}) })
const complete = (reason = 'aborted', answer = ''): Event => ({ kind: 'turn-complete', turnId: 't1', reason, answer, hasJudged: true })
const deliver: Event = { kind: 'deliver-correction', pendingId: 'p1' }

describe('ingress classification', () => {
  test('the table: supersede new work, preserve context, ignore our own commands', async () => {
    const table: [Parameters<typeof classifyIngress>[0], string][] = [
      [{ origin: { kind: 'composer' } }, 'supersede'],
      [{ origin: { kind: 'sdk' } }, 'supersede'],
      [{ origin: { kind: 'bridge' } }, 'supersede'],
      [{ origin: { kind: 'channel' } }, 'supersede'],
      [{ origin: { kind: 'slack-ping' } }, 'supersede'],
      [{ origin: { kind: 'coordinator' } }, 'supersede'],
      [{ origin: { kind: 'projects-relay' } }, 'supersede'],
      [{ origin: { kind: 'auto-continuation' } }, 'supersede'],
      [{ origin: { kind: 'scheduled-trigger' } }, 'supersede'],
      [{ origin: { kind: 'plugin', name: 'other' } }, 'supersede'],
      [{ origin: { kind: 'unclassified' } }, 'supersede'],
      [{ origin: { kind: 'something-new' } }, 'supersede'],
      [{ origin: { kind: 'composer' }, command: { name: 'review' } }, 'supersede'],
      [{ origin: { kind: 'task-notification' }, command: { name: 'loop' } }, 'supersede'],
      [{ origin: { kind: 'composer' }, command: { name: 'stream-rules' } }, 'ignore'],
      [{ origin: { kind: 'composer' }, command: { name: 'stream-rules-draft' } }, 'ignore'],
      [{ origin: { kind: 'plugin', name: 'stream-rules' } }, 'preserve'],
      [{ origin: { kind: 'task-notification' } }, 'preserve'],
      [{ origin: { kind: 'peer' } }, 'preserve'],
      [{ origin: { kind: 'peer-send-message' } }, 'preserve'],
      [{ origin: { kind: 'observer' } }, 'preserve'],
      [{ origin: { kind: 'observer-activity' } }, 'preserve'],
      [{ origin: { kind: 'unclassified' }, isMeta: true }, 'preserve'],
    ]
    for (const [i, want] of table) expect(`${JSON.stringify(i)} ${classifyIngress(i)}`).toBe(`${JSON.stringify(i)} ${want}`)
  })
})

describe('transition', () => {
  test('match on the owned main turn claims, opens a pending correction and asks for an abort', async () => {
    const { s, kinds } = run([start, { kind: 'step' }, match([STOP, SOFT])])
    expect(kinds).toEqual(['2:abort'])
    expect(s.pending?.rules).toEqual(['stop', 'soft'])
    expect(s.corrections).toBe(1)
    expect(firedAt(s, 'main', 'stop')).toBe(1)
  })

  test('happy path: abort ok, complete schedules, delivery submits once and clears the pending record', async () => {
    const { s, kinds } = run([start, match([STOP]), { kind: 'abort-result', pendingId: 'p1', ok: true }, complete(), deliver, deliver])
    expect(kinds).toEqual(['1:abort', '3:schedule-correction', '4:submit'])
    expect(s.pending).toBe(null)
  })

  test('every superseding event drops the pending correction and releases its claim', async () => {
    for (const ev of [ingress('composer'), ingress('scheduled-trigger'), command('review'), { kind: 'set-mode', mode: 'off' } as Event, { kind: 'set-mode', mode: 'on' } as Event, { kind: 'reload' } as Event]) {
      const { s, kinds } = run([start, match([STOP]), ev, complete(), deliver])
      expect(kinds).toEqual(['1:abort', '2:log'])
      expect(s.pending).toBe(null)
      expect(firedAt(s, 'main', 'stop')).toBe(undefined)
    }
  })

  test('preserving ingress keeps the pending correction and the turn owned', async () => {
    const { kinds } = run([start, ingress('task-notification'), match([STOP]), ingress('peer-send-message'), complete(), deliver])
    expect(kinds).toEqual(['2:abort', '4:schedule-correction', '5:submit'])
  })

  test('our own commands neither supersede nor reset the cap', async () => {
    const { s } = run([start, match([STOP]), command('stream-rules')])
    expect(s.pending).not.toBe(null)
    expect(s.corrections).toBe(1)
  })

  test('a superseding prompt resets the cap; ours does not', async () => {
    expect(run([start, match([STOP]), ingress('plugin', { name: 'stream-rules' })]).s.corrections).toBe(1)
    expect(run([start, match([STOP]), command('review')]).s.corrections).toBe(0)
  })

  test('a turn started before a superseding prompt is neither stopped nor judged', async () => {
    const { kinds } = run([start, ingress('composer'), match([STOP]), complete('answer', 'done')])
    expect(kinds).toEqual(['2:remind'])
  })

  test('a refused abort turns the stop into a reminder and gives back the correction', async () => {
    const { s, kinds } = run([start, match([STOP]), { kind: 'abort-result', pendingId: 'p1', ok: false, error: 'no' }])
    expect(kinds).toEqual(['1:abort', '2:error', '2:remind'])
    expect(s.pending).toBe(null)
    expect(s.corrections).toBe(0)
  })

  test('subagent matches remind with the agent id; the cap and pending stay untouched', async () => {
    const { s, actions } = run([start, match([STOP], 'a1')])
    expect(actions.map(([, a]) => a)).toEqual([expect.objectContaining({ kind: 'remind', agentId: 'a1' })])
    expect(s.pending).toBe(null)
  })

  test('judging: scheduled only for the owned answered turn; a result is claimed only while current', async () => {
    expect(run([start, complete('answer', 'done')]).kinds).toEqual(['1:schedule-judge'])
    expect(run([start, complete('aborted', 'done')]).kinds).toEqual([])
    const fresh = run([start, { kind: 'judge-result', epoch: 0, broken: [JUDGED] }])
    expect(fresh.kinds).toEqual(['1:remind'])
    const stale = run([start, ingress('composer'), { kind: 'judge-result', epoch: 0, broken: [JUDGED] }])
    expect(stale.kinds).toEqual([])
    const off = run([start, { kind: 'set-mode', mode: 'off' }, { kind: 'judge-result', epoch: 1, broken: [JUDGED] }])
    expect(off.kinds).toEqual([])
  })

  test('judgeAction correct submits and counts toward the cap', async () => {
    const cfg = configFrom({ judgeAction: 'correct' })
    const r = run([start, { kind: 'judge-result', epoch: 0, broken: [JUDGED] }], INITIAL, cfg)
    expect(r.kinds).toEqual(['1:submit'])
    expect(r.s.corrections).toBe(1)
  })

  test('tool matches: a deny carries every claimed rule; off claims nothing', async () => {
    const tool = spec("condition: 'x'\nscope: [tool]", 'tool')
    const softTool = spec("condition: 'x'\nscope: [tool]\ninterrupt: false", 'soft-tool')
    const { actions } = run([{ kind: 'tool-match', hits: [tool, softTool] }])
    const deny = actions[0]![1]
    expect(deny.kind).toBe('deny')
    expect(deny.kind === 'deny' && deny.text).toContain('Message for soft-tool.')
    expect(run([{ kind: 'set-mode', mode: 'off' }, { kind: 'tool-match', hits: [tool] }]).kinds).toEqual([])
  })

  test('tool routing: an eligible ordinary refusal wins alone; otherwise routing joins the claim', async () => {
    const route = spec('matcher: bash-native-read', 'route')
    const stopOnce = spec("condition: 'x'\nscope: ['tool:Bash']\nrepeat: once", 'stop-once')
    const soft = spec("condition: 'x'\nscope: ['tool:Bash']\ninterrupt: false", 'soft-bash')
    const textOf = (a: Action | undefined) => (a !== undefined && (a.kind === 'deny' || a.kind === 'note') ? a.text : '')

    // ordinary refusal: routing is neither claimed nor mentioned
    const first = run([{ kind: 'tool-match', hits: [stopOnce, route] }])
    expect(first.kinds).toEqual(['0:deny'])
    expect(textOf(first.actions[0]![1])).toContain('Message for stop-once.')
    expect(textOf(first.actions[0]![1])).not.toContain('Message for route.')
    expect(firedAt(first.s, 'main', 'route')).toBe(undefined)

    // the ordinary rule is spent: routing refuses instead of being suppressed
    const second = run([{ kind: 'tool-match', hits: [stopOnce, route] }], first.s)
    expect(second.kinds).toEqual(['0:deny'])
    expect(textOf(second.actions[0]![1])).toContain('Message for route.')
    expect(textOf(second.actions[0]![1])).not.toContain('Message for stop-once.')

    // a passive ordinary rule rides along with the routing refusal, both claimed
    const both = run([{ kind: 'tool-match', hits: [soft, route] }])
    expect(both.kinds).toEqual(['0:deny'])
    expect(textOf(both.actions[0]![1])).toContain('Message for soft-bash.')
    expect(textOf(both.actions[0]![1])).toContain('Message for route.')
    expect(firedAt(both.s, 'main', 'soft-bash')).toBe(0)
    expect(firedAt(both.s, 'main', 'route')).toBe(0)
  })

  test('/clear resets everything but the mode, and moves the epoch on', async () => {
    const { s } = run([{ kind: 'set-mode', mode: 'on' }, start, match([STOP]), { kind: 'clear' }])
    expect(s).toEqual({ ...INITIAL, mode: 'on', epoch: 2 })
  })

  test('release undoes only marks that still hold the claimed value', async () => {
    const r = transition(INITIAL, match([SOFT]), config)
    const remind = r.actions[0]!
    if (remind.kind !== 'remind') throw new Error('expected a reminder')
    expect(firedAt(release(r.state, remind.claim), 'main', 'soft')).toBe(undefined)
    const later = { ...r.state, fired: { main: { soft: 9 } } }
    expect(firedAt(release(later, remind.claim), 'main', 'soft')).toBe(9)
  })

  test('isCurrent needs the same epoch and the mod on', async () => {
    expect(isCurrent(config, INITIAL, 0)).toBe(true)
    expect(isCurrent(config, { ...INITIAL, epoch: 1 }, 0)).toBe(false)
    expect(isCurrent(config, { ...INITIAL, mode: 'off' }, 0)).toBe(false)
  })
})
