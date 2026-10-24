import { describe, expect, test } from 'claude-code/testing'

import {
  INITIAL,
  bumpStep,
  canCorrect,
  configFrom,
  firedAt,
  correctionText,
  denyText,
  extractDraft,
  isActive,
  isEligible,
  judgePrompt,
  markFired,
  parseArgs,
  parseDraftArgs,
  parseVerdict,
  reminderText,
  isBypass,
  noteRouting,
  statusText,
} from './policy'
import { parseRule } from './rules'
import type { RuleSpec } from '../types'

const spec = (front: string, name = 'r'): RuleSpec => {
  const r = parseRule(`---\n${front}\n---\nKeep it short.\n`, `${name}.md`, 'user', `/rules/${name}.md`)
  if ('error' in r) throw new Error(r.error)
  return r.rule
}

describe('options and commands', () => {
  test('configFrom fills defaults and refuses nonsense', async () => {
    expect(configFrom({})).toEqual({
      enabled: true,
      maxCorrections: 2,
      judgeModel: 'haiku',
      judgeMaxPerTurn: 3,
      judgeAction: 'remind',
      draftModel: 'haiku',
      toolRouting: false,
    })
    expect(configFrom({ toolRouting: true }).toolRouting).toBe(true)
    expect(configFrom({ toolRouting: 'yes' }).toolRouting).toBe(false)
    const c = configFrom({ enabled: false, maxCorrections: -1, judgeMaxPerTurn: 2.7, judgeAction: 'correct', judgeModel: ' ' })
    expect(c.enabled).toBe(false)
    expect(c.maxCorrections).toBe(0)
    expect(c.judgeMaxPerTurn).toBe(2)
    expect(c.judgeAction).toBe('correct')
    expect(c.judgeModel).toBe('haiku')
  })

  test('a session override beats the enabled option', async () => {
    expect(isActive(configFrom({}), INITIAL)).toBe(true)
    expect(isActive(configFrom({ enabled: false }), INITIAL)).toBe(false)
    expect(isActive(configFrom({ enabled: false }), { ...INITIAL, mode: 'on' })).toBe(true)
    expect(isActive(configFrom({}), { ...INITIAL, mode: 'off' })).toBe(false)
  })

  test('parseArgs reads every subcommand', async () => {
    expect(parseArgs('')).toEqual({ kind: 'status' })
    expect(parseArgs(' LIST ')).toEqual({ kind: 'list' })
    expect(parseArgs('test  a Banana here')).toEqual({ kind: 'test', text: 'a Banana here' })
    expect(parseArgs('test')).toEqual({ kind: 'help', error: 'test needs a text: /stream-rules test <text>' })
    expect(parseArgs('off')).toEqual({ kind: 'set', mode: 'off' })
    expect(parseArgs('reload')).toEqual({ kind: 'reload' })
    expect(parseArgs('reset')).toEqual({ kind: 'reset' })
    expect(parseArgs('bogus')).toEqual({ kind: 'help', error: 'Unknown argument: bogus' })
  })

  test('parseDraftArgs tells a save from a complaint that starts with save', async () => {
    expect(parseDraftArgs('')).toEqual({ kind: 'show' })
    expect(parseDraftArgs('show')).toEqual({ kind: 'show' })
    expect(parseDraftArgs('cancel')).toEqual({ kind: 'cancel' })
    expect(parseDraftArgs('save')).toEqual({ kind: 'save', dest: 'project', overwrite: false })
    expect(parseDraftArgs('save user overwrite')).toEqual({ kind: 'save', dest: 'user', overwrite: true })
    expect(parseDraftArgs('save files before saying done')).toEqual({ kind: 'draft', complaint: 'save files before saying done' })
    expect(parseDraftArgs('it keeps apologizing')).toEqual({ kind: 'draft', complaint: 'it keeps apologizing' })
  })
})

describe('repeat and caps', () => {
  test('once fires once, always every time, after-gap after gap responses', async () => {
    const once = spec("condition: 'x'")
    expect(isEligible(once, 'prose', undefined, 5)).toBe(true)
    expect(isEligible(once, 'prose', 3, 50)).toBe(false)
    // a tool match defaults to always
    expect(isEligible(once, 'tool', 3, 3)).toBe(true)
    const pinnedOnce = spec("condition: 'x'\nrepeat: once")
    expect(isEligible(pinnedOnce, 'tool', 3, 3)).toBe(false)
    const gap = spec("condition: 'x'\nrepeat: after-gap\ngap: 3")
    expect(isEligible(gap, 'prose', 4, 6)).toBe(false)
    expect(isEligible(gap, 'prose', 4, 7)).toBe(true)
  })

  test('markFired and bumpStep keep loops apart', async () => {
    let s = bumpStep(bumpStep(INITIAL, 'main'), 'a1')
    s = bumpStep(s, 'main')
    s = markFired(s, 'main', ['r'])
    expect(s.steps).toEqual({ main: 2, a1: 1 })
    expect(s.fired).toEqual({ main: { r: 2 } })
  })

  test('names like constructor or __proto__ are plain keys, never inherited ones', async () => {
    expect(firedAt(INITIAL, 'main', 'constructor')).toBe(undefined)
    expect(firedAt(INITIAL, 'constructor', 'x')).toBe(undefined)
    const s = markFired(bumpStep(INITIAL, 'main'), 'main', ['__proto__', 'toString'])
    expect(firedAt(s, 'main', '__proto__')).toBe(1)
    expect(firedAt(s, 'main', 'toString')).toBe(1)
    expect(firedAt(s, 'main', 'constructor')).toBe(undefined)
    expect(isEligible(spec("condition: 'x'", 'constructor'), 'prose', firedAt(s, 'main', 'constructor'), 1)).toBe(true)
  })

  test('canCorrect stops at maxCorrections', async () => {
    const c = configFrom({ maxCorrections: 1 })
    expect(canCorrect(c, INITIAL)).toBe(true)
    expect(canCorrect(c, { ...INITIAL, corrections: 1 })).toBe(false)
  })
})

describe('text the model is given', () => {
  const rule = spec("description: No filler\ncondition: 'x'", 'no-filler')

  test('names the rule and its message, and never mentions thinking or reasoning', async () => {
    for (const t of [correctionText([rule]), reminderText([rule]), denyText([rule])]) {
      expect(t).toContain('"no-filler" (No filler)')
      expect(t).toContain('Keep it short.')
      expect(t).not.toMatch(/think|reason/i)
    }
    expect(correctionText([rule])).toContain('Continue the original task')
  })

  test('judge prompt carries the question and the answer; verdicts read yes or no only', async () => {
    const judged = spec('question: Did the reply pad itself with filler?', 'pad')
    const p = judgePrompt(judged, 'The answer.')
    expect(p.prompt).toContain('Did the reply pad itself with filler?')
    expect(p.prompt).toContain('The answer.')
    expect(judgePrompt(judged, 'y'.repeat(40_000)).prompt.length).toBeLessThan(33_000)
    expect(parseVerdict('Yes.')).toBe('yes')
    expect(parseVerdict(' no')).toBe('no')
    expect(parseVerdict('maybe')).toBe(undefined)
  })

  test('extractDraft takes the last <rule> block', async () => {
    const reply = 'Here: <rule>first</rule> and finally\n<rule>\n---\nname: x\n---\nbody\n</rule>\nDone.'
    expect(extractDraft(reply)).toBe('---\nname: x\n---\nbody')
    expect(extractDraft('no tags')).toBe(undefined)
  })

  test('statusText says where the state comes from', async () => {
    const t = statusText(configFrom({}), { ...INITIAL, mode: 'off', corrections: 1 }, 3, 1)
    expect(t).toContain('off (set for this session)')
    expect(t).toContain('3 rules loaded, 1 file failed')
    expect(t).toContain('1 of 2 corrections used')
  })
})

describe('tool routing', () => {
  test('the bypass needs the exact prefix and a reason of 1 to 240 characters', async () => {
    expect(isBypass({ description: '[tool-routing bypass] need bytes' })).toBe(true)
    expect(isBypass({ description: `[tool-routing bypass] ${'x'.repeat(240)}` })).toBe(true)
    expect(isBypass({ description: `[tool-routing bypass] ${'x'.repeat(241)}` })).toBe(false)
    expect(isBypass({ description: '[tool-routing bypass]  ' })).toBe(false)
    expect(isBypass({ description: '[tool-routing bypass]x' })).toBe(false)
    expect(isBypass({ description: '[Tool-routing bypass] x' })).toBe(false)
    expect(isBypass({ description: 'x [tool-routing bypass] y' })).toBe(false)
    expect(isBypass({ command: 'cat a' })).toBe(false)
    expect(isBypass(null)).toBe(false)
  })

  test('parseArgs reads test-tool Bash <command>, keeping the command whole', async () => {
    expect(parseArgs("test-tool Bash cat 'a b' | wc -l")).toEqual({ kind: 'test-tool', command: "cat 'a b' | wc -l" })
    expect(parseArgs('test-tool bash ls')).toEqual({ kind: 'test-tool', command: 'ls' })
    expect(parseArgs('test-tool Read x').kind).toBe('help')
    expect(parseArgs('test-tool').kind).toBe('help')
  })

  test('routing counts never hold command text, and limit keeps the last unsupported reason', async () => {
    let s = noteRouting(INITIAL, 'unsupported', 'a heredoc')
    s = noteRouting(s, 'limit', 'more than 256 commands')
    s = noteRouting(s, 'bypassed')
    expect(s.routing).toEqual({ unsupported: 1, limit: 1, bypassed: 1, lastReason: 'a heredoc' })
  })
})
