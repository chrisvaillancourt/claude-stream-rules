import { describe, expect, mock, test } from 'claude-code/testing'
import type { ModelCompleteResult, On, SessionMessage, TurnStepChunk } from 'claude-code'

const HOME = '/home/u'
const CWD = '/proj'
const USER_DIR = `${HOME}/.claude/stream-rules`
const PROJECT_DIR = `${CWD}/.claude/stream-rules`
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const BANANA = "---\ndescription: No bananas\ncondition: '(?i)banana'\nscope: [text]\n---\nSay fruit instead.\n"
const NO_RM = "---\ndescription: No rm -rf\ncondition: 'rm\\s+-rf'\nscope: ['tool:Bash']\n---\nUse trash instead.\n"
const NOTE_TS = "---\ncondition: ': any\\b'\nscope: ['tool:Edit(*.ts)']\ninterrupt: false\n---\nPrefer unknown.\n"
const JUDGED = '---\ndescription: Show the test output\nquestion: Does the reply claim tests passed without showing output?\n---\nPaste the test output.\n'

type Opts = { files?: Record<string, string>; abortFails?: boolean; judge?: (prompt: string) => ModelCompleteResult | Promise<ModelCompleteResult>; messages?: SessionMessage[] }

/** The engine beneath the plugin. `stream` sets the chunks the next model request yields. */
const world = (on: On, opts: Opts = {}) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME })
  const session = mock.session(on)
  const files = new Map<string, string>(Object.entries(opts.files ?? {}))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) || [...files.keys()].some(k => k.startsWith(`${e.path}/`)) }))
  on('fs.read', ($, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: t }
  })
  const writes: string[] = []
  on('fs.write', ($, e) => {
    writes.push(e.path)
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', ($, e) => ({
    value: [...files.keys()]
      .filter(k => k.startsWith(`${e.path}/`) && !k.slice(e.path.length + 1).includes('/'))
      .map(k => ({ name: k.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  const logs: string[] = []
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })

  let chunks: TurnStepChunk[] = []
  const yielded: TurnStepChunk[] = []
  on('turn.step', async function* ($, e) {
    let answer = ''
    for (const c of chunks) {
      if (c.kind === 'text') answer += c.text
      yield c
    }
    return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  const aborts: string[] = []
  on('turn.abort', ($, e) => {
    aborts.push(e.turnId)
    if (opts.abortFails) throw new Error('not the running turn')
    return { value: undefined }
  })
  const submits: string[] = []
  on('prompt.submit', ($, e) => {
    submits.push(e.text)
    return { text: e.text }
  })
  const ran: string[] = []
  on('tool.call', ($, e) => {
    ran.push(String(e.tool))
    return { result: 'ok', text: 'ok' }
  })
  const completions: string[] = []
  on('model.complete', async ($, e) => {
    completions.push(e.prompt)
    const fn = opts.judge ?? (() => ({ isAnswered: true as const, text: 'no', usage: USAGE }))
    return { value: await fn(e.prompt) }
  })
  on('session.messages', () => ({ value: opts.messages ?? [] }))

  return {
    clock,
    files,
    writes,
    logs,
    aborts,
    submits,
    ran,
    completions,
    appended: () => session.appended().filter(r => r.door === 'note'),
    stream: (c: TurnStepChunk[]) => (chunks = c),
    yielded,
  }
}

const start = ($: any) => $.session.start({ cwd: CWD, surface: null, isInteractive: false })
const COMMAND = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }
const cmd = ($: any, args: string) => $.command.run({ command: 'stream-rules', args, ...COMMAND })
const draftCmd = ($: any, args: string) => $.command.run({ command: 'stream-rules-draft', args, ...COMMAND })

const text = (t: string, index = 0): TurnStepChunk => ({ kind: 'text', index, text: t })

/** Runs one model request through the plugins and returns what reached the engine above them. */
const step = async ($: any, turnId: string, index = 0, agentId?: string) => {
  const out: TurnStepChunk[] = []
  const s = $.turn.step({ turnId, index, model: 'claude-opus-5-5', messageCount: 2, ...(agentId ? { agentId } : {}) })
  for await (const c of s) out.push(c)
  return out
}

const shown = (chunks: TurnStepChunk[]) => chunks.map(c => (c.kind === 'text' ? c.text : `<${c.kind}>`)).join('')

/** A main-loop turn: start, one request, complete with `reason`. */
const turn = async ($: any, w: ReturnType<typeof world>, turnId: string, chunks: TurnStepChunk[], reason: 'answer' | 'aborted' = 'answer') => {
  w.stream(chunks)
  await $.turn.start({ text: 'go', turnId })
  const out = await step($, turnId)
  await $.turn.complete({ turnId, answer: shown(out), durationMs: 1, isAborted: reason === 'aborted', reason })
  await w.clock.settle()
  return out
}

describe('tool rules', () => {
  test('an interrupting rule refuses the call before it runs, main loop and subagents alike', async ($, on) => {
    const w = world(on, { files: { [`${USER_DIR}/no-rm.md`]: NO_RM } })
    await start($)
    const denied = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
    expect(denied.deny).toContain('Use trash instead.')
    const sub = await $.tool.call({ tool: 'Bash', command: 'rm  -rf x', agentId: 'a1' })
    expect(sub.deny).toContain('"no-rm" (No rm -rf)')
    const fine = await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(fine.deny).toBeUndefined()
    expect(w.ran).toEqual(['Bash'])
  })

  test('a non-interrupting rule lets the call run and adds a note after the result', async ($, on) => {
    const w = world(on, { files: { [`${PROJECT_DIR}/note-ts.md`]: NOTE_TS } })
    await start($)
    const r = await $.tool.call({ tool: 'Edit', file_path: '/proj/a.ts', old_string: 'x', new_string: 'x: any' })
    expect(w.ran).toEqual(['Edit'])
    expect(r.context?.[0]).toContain('Prefer unknown.')
    const md = await $.tool.call({ tool: 'Edit', file_path: '/proj/a.md', old_string: 'x', new_string: 'x: any' })
    expect(md.context).toBeUndefined()
  })

  test('/stream-rules off lets everything through', async ($, on) => {
    const w = world(on, { files: { [`${USER_DIR}/no-rm.md`]: NO_RM } })
    await start($)
    expect((await cmd($, 'off')).text).toContain('off (set for this session)')
    const r = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
    expect(r.deny).toBeUndefined()
    expect(w.ran).toEqual(['Bash'])
  })
})

describe('prose rules on the main loop', () => {
  test('a match split across chunks stops the reply, aborts the turn and sends one corrective prompt', async ($, on) => {
    const w = world(on, { files: { [`${USER_DIR}/banana.md`]: BANANA } })
    await start($)
    const out = await turn($, w, 't1', [text('I like the ban'), text('ana a lot. '), text('More text.'), { kind: 'tool', index: 1, id: 'tu1', name: 'Bash' }], 'aborted')
    expect(shown(out)).toBe('I like the ban')
    expect(w.aborts).toEqual(['t1'])
    expect(w.submits).toHaveLength(1)
    expect(w.submits[0]).toContain('Say fruit instead.')
    expect(w.submits[0]).toContain('Continue the original task')

    // the corrective turn says it again: a `once` rule doesn't fire twice
    const again = await turn($, w, 't2', [text('banana again')])
    expect(shown(again)).toBe('banana again')
    expect(w.aborts).toEqual(['t1'])
    expect(w.submits).toHaveLength(1)
  })

  test('past maxCorrections a match becomes a reminder and the reply goes on', async ($, on) => {
    const always = BANANA.replace('scope: [text]', 'scope: [text]\nrepeat: always')
    const w = world(on, { files: { [`${USER_DIR}/banana.md`]: always } })
    await start($)
    await turn($, w, 't1', [text('banana')], 'aborted')
    await turn($, w, 't2', [text('banana')], 'aborted')
    const third = await turn($, w, 't3', [text('banana split')])
    expect(w.aborts).toEqual(['t1', 't2'])
    expect(w.submits).toHaveLength(2)
    expect(shown(third)).toBe('banana split')
    expect(JSON.stringify(w.appended().at(-1)?.message)).toContain('Say fruit instead.')

    // a prompt from the person resets the count
    await $.prompt.submit({ text: 'next task', wait: false, origin: { kind: 'composer' } })
    await turn($, w, 't4', [text('banana')], 'aborted')
    expect(w.aborts).toEqual(['t1', 't2', 't4'])
  })

  test('maxCorrections 0 turns every stop into a reminder', { options: { maxCorrections: 0 } }, async ($, on) => {
    const w = world(on, { files: { [`${USER_DIR}/banana.md`]: BANANA } })
    await start($)
    const out = await turn($, w, 't1', [text('a banana'), text(' split')])
    expect(shown(out)).toBe('a banana split')
    expect(w.aborts).toEqual([])
    expect(w.appended()).toHaveLength(1)
  })

  test('when the abort is refused, the withheld text is passed on and a reminder is added', async ($, on) => {
    const w = world(on, { abortFails: true, files: { [`${USER_DIR}/banana.md`]: BANANA } })
    await start($)
    const out = await turn($, w, 't1', [text('a banana'), text(' and more')])
    expect(shown(out)).toBe('a banana and more')
    expect(w.submits).toEqual([])
    expect(JSON.stringify(w.appended().at(-1)?.message)).toContain('Say fruit instead.')
    expect((await cmd($, 'status')).text).toContain('Last error')
  })

  test('a non-interrupting prose rule adds a reminder without stopping', async ($, on) => {
    const w = world(on, { files: { [`${USER_DIR}/banana.md`]: BANANA.replace('scope: [text]', 'scope: [text]\ninterrupt: false') } })
    await start($)
    const out = await turn($, w, 't1', [text('a banana')])
    expect(shown(out)).toBe('a banana')
    expect(w.aborts).toEqual([])
    expect(w.appended()).toHaveLength(1)
  })

  test('thinking is watched only when a rule names it', async ($, on) => {
    const w = world(on, { files: { [`${USER_DIR}/banana.md`]: BANANA } })
    await start($)
    await turn($, w, 't1', [{ kind: 'thinking', index: 0, text: 'banana' }, text('ok', 1)])
    expect(w.aborts).toEqual([])
  })
})

describe('prose rules in subagents', () => {
  test('a match appends a reminder to the subagent instead of aborting', async ($, on) => {
    const w = world(on, { files: { [`${USER_DIR}/banana.md`]: BANANA } })
    await start($)
    w.stream([text('banana')])
    await $.turn.start({ text: 'sub', turnId: 's1', agentId: 'a1' })
    const out = await step($, 's1', 0, 'a1')
    expect(shown(out)).toBe('banana')
    expect(w.aborts).toEqual([])
    const row = w.appended().at(-1)
    expect(row?.agentId).toBe('a1')
    expect(JSON.stringify(row?.message)).toContain('Say fruit instead.')
  })
})

describe('pending corrections', () => {
  test('/clear drops a pending correction', async ($, on) => {
    const w = world(on, { files: { [`${USER_DIR}/banana.md`]: BANANA } })
    await start($)
    w.stream([text('banana')])
    await $.turn.start({ text: 'go', turnId: 't1' })
    await step($, 't1')
    await $.session.end({ reason: 'clear', sessionId: 'x', resume: { id: 'x' } })
    await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: true, reason: 'aborted' })
    await w.clock.settle()
    expect(w.submits).toEqual([])
  })

  test('a pending correction found at session start (a reload) is dropped and logged', async ($, on) => {
    const w = world(on, { files: { [`${USER_DIR}/banana.md`]: BANANA } })
    await start($)
    w.stream([text('banana')])
    await $.turn.start({ text: 'go', turnId: 't1' })
    await step($, 't1')
    await start($)
    await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: true, reason: 'aborted' })
    await w.clock.settle()
    expect(w.submits).toEqual([])
    expect(w.logs.join('\n')).toContain('dropped a pending correction')
  })
})

describe('judged rules', () => {
  test('a yes adds the rule as a reminder; no model call without judged rules', async ($, on) => {
    const w = world(on, {
      files: { [`${USER_DIR}/judged.md`]: JUDGED },
      judge: () => ({ isAnswered: true, text: 'Yes', usage: USAGE }),
    })
    await start($)
    await turn($, w, 't1', [text('All tests pass.')])
    expect(w.completions).toHaveLength(1)
    expect(w.completions[0]).toContain('All tests pass.')
    expect(JSON.stringify(w.appended().at(-1)?.message)).toContain('Paste the test output.')
    expect(w.submits).toEqual([])
  })

  test('a no, an unclear answer or a failed call adds nothing', async ($, on) => {
    let answer: ModelCompleteResult = { isAnswered: true, text: 'no', usage: USAGE }
    const w = world(on, { files: { [`${USER_DIR}/judged.md`]: JUDGED }, judge: () => answer })
    await start($)
    await turn($, w, 't1', [text('done')])
    answer = { isAnswered: true, text: 'perhaps', usage: USAGE }
    await turn($, w, 't2', [text('done')])
    answer = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE }
    await turn($, w, 't3', [text('done')])
    expect(w.completions).toHaveLength(3)
    expect(w.appended()).toEqual([])
  })

  test('without a judged rule no model is called', async ($, on) => {
    const w = world(on, { files: { [`${USER_DIR}/banana.md`]: BANANA } })
    await start($)
    await turn($, w, 't1', [text('apple')])
    expect(w.completions).toEqual([])
  })
})

describe('/stream-rules', () => {
  test('list shows rules and the files that failed to load', async ($, on) => {
    world(on, { files: { [`${USER_DIR}/banana.md`]: BANANA, [`${USER_DIR}/judged.md`]: JUDGED, [`${PROJECT_DIR}/broken.md`]: 'no frontmatter' } })
    await start($)
    const t = (await cmd($, 'list')).text ?? ''
    expect(t).toContain('banana (user, stops; text): No bananas')
    expect(t).toContain('judged (user, judged; the final answer): Show the test output')
    expect(t).toContain(`${PROJECT_DIR}/broken.md: no frontmatter`)
  })

  test('test reports which rules match a text', async ($, on) => {
    world(on, { files: { [`${USER_DIR}/banana.md`]: BANANA } })
    await start($)
    expect((await cmd($, 'test I want a Banana')).text).toContain('banana: matches')
    expect((await cmd($, 'test apples')).text).toBe('No rule matches that text.')
  })

  test('reload picks up a new file', async ($, on) => {
    const w = world(on)
    await start($)
    expect((await cmd($, 'status')).text).toContain('0 rules loaded')
    w.files.set(`${USER_DIR}/banana.md`, BANANA)
    expect((await cmd($, 'reload')).text).toContain('1 rules loaded')
  })
})

describe('/stream-rules-draft', () => {
  const DRAFT = "<rule>\n---\nname: no-sorry\ndescription: Stop apologizing\ncondition: '(?i)\\bsorry\\b'\nscope: [text]\n---\nSkip the apology and fix it.\n</rule>"

  test('drafts, reports matches in recent replies, and writes only on save', async ($, on) => {
    const w = world(on, {
      judge: () => ({ isAnswered: true, text: DRAFT, usage: USAGE }),
      messages: [
        { role: 'user', text: 'fix it', toolUses: [] },
        { role: 'assistant', text: 'Sorry about that!', toolUses: [] },
        { role: 'assistant', text: 'Done.', toolUses: [] },
      ],
    })
    await start($)
    const shownDraft = (await draftCmd($, 'it keeps apologizing')).text ?? ''
    expect(w.completions[0]).toContain('it keeps apologizing')
    expect(w.completions[0]).toContain('Sorry about that!')
    expect(shownDraft).toContain('name: no-sorry')
    expect(shownDraft).toContain('matches 1 of the last 2 assistant messages')
    expect(w.writes).toEqual([])

    const saved = (await draftCmd($, 'save')).text ?? ''
    expect(saved).toContain(`${PROJECT_DIR}/no-sorry.md`)
    expect(w.files.get(`${PROJECT_DIR}/no-sorry.md`)).toContain('Skip the apology and fix it.')
    expect((await cmd($, 'test sorry')).text).toContain('no-sorry: matches')
  })

  test('save refuses to replace a file unless told to overwrite', async ($, on) => {
    const w = world(on, {
      files: { [`${USER_DIR}/no-sorry.md`]: BANANA },
      judge: () => ({ isAnswered: true, text: DRAFT, usage: USAGE }),
    })
    await start($)
    await draftCmd($, 'stop apologizing')
    expect((await draftCmd($, 'save user')).text).toContain('already exists')
    expect(w.files.get(`${USER_DIR}/no-sorry.md`)).toBe(BANANA)
    await draftCmd($, 'save user overwrite')
    expect(w.files.get(`${USER_DIR}/no-sorry.md`)).toContain('Skip the apology')
  })

  test('a draft that does not parse is shown with its error and not held', async ($, on) => {
    world(on, { judge: () => ({ isAnswered: true, text: '<rule>\n---\nname: x\n---\nbody\n</rule>', usage: USAGE }) })
    await start($)
    expect((await draftCmd($, 'complaint')).text).toContain('a rule needs a condition or a question')
    expect((await draftCmd($, 'save')).text).toContain('No draft is held')
  })
})

describe('lifecycle and review regressions', () => {
  test('inherited-property rule names remain eligible', async ($, on) => {
    const w = world(on, { files: {
      [`${USER_DIR}/banana.md`]: BANANA.replace('banana', 'apple').replace('(?i)banana', '(?i)apple').replace('scope: [text]', 'scope: [text]\ninterrupt: false'),
      [`${USER_DIR}/constructor.md`]: BANANA.replace('scope: [text]', 'scope: [text]\ninterrupt: false'),
    } })
    await start($)
    await turn($, w, 't1', [text('apple')])
    await turn($, w, 't2', [text('banana')])
    expect(w.appended().map(x => x.message.content).flat()).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('Rule "constructor"') })]))
  })
})
