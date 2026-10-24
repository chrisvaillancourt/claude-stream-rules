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

type Opts = { tools?: string[] | 'fail'; files?: Record<string, string>; abortFails?: boolean; toolDenyFirst?: boolean; judge?: (prompt: string) => ModelCompleteResult | Promise<ModelCompleteResult>; messages?: SessionMessage[] }

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
  const inputs: unknown[] = []
  on('tool.call', ($, e) => {
    ran.push(String(e.tool))
    inputs.push(e)
    if (opts.toolDenyFirst && ran.length === 1) return { deny: 'Permission refused.' }
    return { result: 'ok', text: 'ok' }
  })
  const completions: string[] = []
  on('model.complete', async ($, e) => {
    completions.push(e.prompt)
    const fn = opts.judge ?? (() => ({ isAnswered: true as const, text: 'no', usage: USAGE }))
    return { value: await fn(e.prompt) }
  })
  on('session.messages', () => ({ value: opts.messages ?? [] }))
  const tools = opts.tools ?? ['Bash', 'Read', 'Edit', 'Write']
  on('tool.list', () => {
    if (tools === 'fail') throw new Error('no tools')
    return { value: tools.map(name => ({ name, description: name, mcp: false })) }
  })

  return {
    clock,
    files,
    writes,
    logs,
    aborts,
    submits,
    ran,
    inputs,
    completions,
    appended: () => session.appended().filter(r => r.door === 'note'),
    stream: (c: TurnStepChunk[]) => (chunks = c),
    yielded,
  }
}

/** A promise and the function that settles it (Promise.withResolvers, which the es2023 lib lacks). */
function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>(r => (resolve = r))
  return { promise, resolve }
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
    expect(w.logs.join('\n')).toContain('dropped the correction for banana (the mod reloaded')
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
    expect(shownDraft).toContain('matches 1 of the last 2 assistant replies')
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
  test('newer user input invalidates an old correction', async ($, on) => {
    const w = world(on, { files: { [`${USER_DIR}/banana.md`]: BANANA } })
    await start($)
    w.stream([text('banana')])
    await $.turn.start({ text: 'old task', turnId: 't1' })
    await step($, 't1')
    await $.prompt.submit({ text: 'Stop the old task; do a different task.', wait: false, origin: { kind: 'composer' } })
    await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: true, reason: 'aborted' })
    await w.clock.settle()
    expect(w.submits).toEqual(['Stop the old task; do a different task.'])
  })

  test('off invalidates a pending correction', async ($, on) => {
    const w = world(on, { files: { [`${USER_DIR}/banana.md`]: BANANA } })
    await start($)
    w.stream([text('banana')])
    await $.turn.start({ text: 'go', turnId: 't1' })
    await step($, 't1')
    await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: true, reason: 'aborted' })
    await cmd($, 'off')
    await w.clock.settle()
    expect(w.submits).toEqual([])
  })

  test('off while judging prevents a new corrective turn', { options: { judgeAction: 'correct' } }, async ($, on) => {
    const w = world(on, {
      files: { [`${USER_DIR}/judged.md`]: JUDGED },
      judge: async () => {
        await cmd($, 'off')
        return { isAnswered: true, text: 'yes', usage: USAGE }
      },
    })
    await start($)
    await turn($, w, 't1', [text('All tests pass.')])
    expect(w.submits).toEqual([])
  })

  test('newer input while judging prevents revision of the wrong answer', { options: { judgeAction: 'correct' } }, async ($, on) => {
    const w = world(on, {
      files: { [`${USER_DIR}/judged.md`]: JUDGED },
      judge: async () => {
        await $.prompt.submit({ text: 'New task.', wait: false, origin: { kind: 'composer' } })
        return { isAnswered: true, text: 'yes', usage: USAGE }
      },
    })
    await start($)
    await turn($, w, 't1', [text('All tests pass.')])
    expect(w.submits).toEqual(['New task.'])
  })

  test('off while judging adds no reminder either', async ($, on) => {
    const w = world(on, {
      files: { [`${USER_DIR}/judged.md`]: JUDGED },
      judge: async () => {
        await cmd($, 'off')
        return { isAnswered: true, text: 'yes', usage: USAGE }
      },
    })
    await start($)
    await turn($, w, 't1', [text('All tests pass.')])
    expect(w.appended()).toEqual([])
  })

  test('a prompt typed during the turn means its answer is not judged into the new task', async ($, on) => {
    const w = world(on, { files: { [`${USER_DIR}/judged.md`]: JUDGED }, judge: () => ({ isAnswered: true, text: 'yes', usage: USAGE }) })
    await start($)
    w.stream([text('All tests pass.')])
    await $.turn.start({ text: 'go', turnId: 't1' })
    await step($, 't1')
    await $.prompt.submit({ text: 'New task.', wait: false, origin: { kind: 'composer' }, turnId: 't1' })
    await $.turn.complete({ turnId: 't1', answer: 'All tests pass.', durationMs: 1, isAborted: false, reason: 'answer' })
    await w.clock.settle()
    expect(w.completions).toEqual([])
    expect(w.appended()).toEqual([])
  })

  test('off then on before the timer still drops the old correction', async ($, on) => {
    const w = world(on, { files: { [`${USER_DIR}/banana.md`]: BANANA } })
    await start($)
    w.stream([text('banana')])
    await $.turn.start({ text: 'go', turnId: 't1' })
    await step($, 't1')
    await cmd($, 'off')
    await cmd($, 'on')
    await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: true, reason: 'aborted' })
    await w.clock.settle()
    expect(w.submits).toEqual([])
  })

  test('/clear while judging drops the verdict', { options: { judgeAction: 'correct' } }, async ($, on) => {
    const w = world(on, {
      files: { [`${USER_DIR}/judged.md`]: JUDGED },
      judge: async () => {
        await $.session.end({ reason: 'clear', sessionId: 'x', resume: { id: 'x' } })
        return { isAnswered: true, text: 'yes', usage: USAGE }
      },
    })
    await start($)
    await turn($, w, 't1', [text('All tests pass.')])
    expect(w.submits).toEqual([])
    expect(w.appended()).toEqual([])
  })

  test('tool drafts do not count prose as live tool matches', async ($, on) => {
    const draft = "<rule>\n---\nname: no-any\ncondition: ': any\\b'\nscope: ['tool:Edit(*.ts)']\n---\nUse unknown.\n</rule>"
    world(on, {
      judge: () => ({ isAnswered: true, text: draft, usage: USAGE }),
      messages: [{ role: 'assistant', text: 'The documentation explains : any as an example.', toolUses: [] }],
    })
    await start($)
    const result = (await draftCmd($, 'avoid any in TypeScript edits')).text ?? ''
    expect(result).toContain('matches 0')
  })

  test('tool drafts are checked against recent tool calls through the live matcher', async ($, on) => {
    const draft = "<rule>\n---\nname: no-any\ncondition: ': any\\b'\nscope: ['tool:Edit(*.ts)']\n---\nUse unknown.\n</rule>"
    const edit = (path: string) => ({ tool_use_id: path, tool: 'Edit', input: { file_path: path, old_string: '', new_string: 'let x: any' } })
    world(on, {
      judge: () => ({ isAnswered: true, text: draft, usage: USAGE }),
      messages: [{ role: 'assistant', text: 'Editing.', toolUses: [edit('/p/a.ts'), edit('/p/a.md')] }],
    })
    await start($)
    const result = (await draftCmd($, 'avoid any')).text ?? ''
    expect(result).toContain('matches 1 of the last 2 tool calls')
    expect(result).not.toContain('replies')
  })

  test('denying one rule must not consume undelivered passive guidance', async ($, on) => {
    const passive = "---\ncondition: 'touch'\nscope: ['tool:Bash']\ninterrupt: false\nrepeat: once\n---\nPASSIVE MESSAGE\n"
    const stopRule = "---\ncondition: 'secret'\nscope: ['tool:Bash']\n---\nSTOP MESSAGE\n"
    const w = world(on, { files: { [`${USER_DIR}/passive.md`]: passive, [`${USER_DIR}/stop.md`]: stopRule } })
    await start($)
    const first = await $.tool.call({ tool: 'Bash', command: 'touch secret' })
    const second = await $.tool.call({ tool: 'Bash', command: 'touch public' })
    expect(`${first.deny ?? ''}\n${second.context?.join('\n') ?? ''}`).toContain('PASSIVE MESSAGE')
  })

  test('malformed quoted condition is reported rather than broadened', async ($, on) => {
    world(on, { files: { [`${USER_DIR}/broken.md`]: "---\ncondition: '(?i)you're right'\nscope: [text]\n---\nDo not flatter.\n" } })
    await start($)
    expect((await cmd($, 'list')).text).toContain('Files that failed to load:')
  })

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

describe('ownership interleavings (round 2)', () => {
  test('a newer skill prompt invalidates an in-flight judgment', { options: { judgeAction: 'correct' } }, async ($, on) => {
    const w = world(on, {
      files: { [`${USER_DIR}/judged.md`]: JUDGED },
      judge: async () => {
        await $.prompt.submit({ text: '/review', wait: false, origin: { kind: 'composer' }, command: { name: 'review', args: '' } })
        return { isAnswered: true, text: 'yes', usage: USAGE }
      },
    })
    await start($)
    await turn($, w, 't1', [text('All tests pass.')])
    expect(w.submits).toEqual(['/review'])
  })

  test('a newer skill prompt receives a fresh correction cap', async ($, on) => {
    const w = world(on, { files: { [`${USER_DIR}/banana.md`]: BANANA.replace('scope: [text]', 'scope: [text]\nrepeat: always') } })
    await start($)
    await turn($, w, 't1', [text('banana')], 'aborted')
    await turn($, w, 't2', [text('banana')], 'aborted')
    await $.prompt.submit({ text: '/review', wait: false, origin: { kind: 'composer' }, command: { name: 'review', args: '' } })
    await turn($, w, 't3', [text('banana')], 'aborted')
    expect(w.aborts).toEqual(['t1', 't2', 't3'])
  })

  test('a background result does not disable interruption for the running task', async ($, on) => {
    const w = world(on, { files: { [`${USER_DIR}/banana.md`]: BANANA } })
    await start($)
    await $.turn.start({ text: 'finish the work', turnId: 't1' })
    await $.prompt.submit({ text: 'Background task completed.', wait: false, origin: { kind: 'task-notification' }, turnId: 't1', isMeta: true })
    w.stream([text('banana')])
    await step($, 't1')
    expect(w.aborts).toEqual(['t1'])
  })

  test('a teammate report does not disable interruption for the running task', async ($, on) => {
    const w = world(on, { files: { [`${USER_DIR}/banana.md`]: BANANA } })
    await start($)
    await $.turn.start({ text: 'finish the work', turnId: 't1' })
    await $.prompt.submit({ text: 'The delegated work is complete.', wait: false, origin: { kind: 'peer-send-message' }, turnId: 't1', isMeta: true })
    w.stream([text('banana')])
    await step($, 't1')
    expect(w.aborts).toEqual(['t1'])
  })

  test('a task notification does not discard a pending correction', async ($, on) => {
    const w = world(on, { files: { [`${USER_DIR}/banana.md`]: BANANA } })
    await start($)
    await $.turn.start({ text: 'finish the work', turnId: 't1' })
    w.stream([text('banana')])
    await step($, 't1')
    await $.prompt.submit({ text: 'Background task completed.', wait: false, origin: { kind: 'task-notification' }, turnId: 't1', isMeta: true })
    await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: true, reason: 'aborted' })
    await w.clock.settle()
    expect(w.submits.join('\n')).toContain('Say fruit instead.')
  })

  test('off after a judgment claim but before delivery still prevents the correction', { options: { judgeAction: 'correct' } }, async ($, on) => {
    const w = world(on, { files: { [`${USER_DIR}/judged.md`]: JUDGED }, judge: () => ({ isAnswered: true, text: 'yes', usage: USAGE }) })
    const { promise: claimed, resolve: claimReached } = gate()
    const { promise: resume, resolve: release } = gate()
    let held = false
    on('state.set', { plugin: 'stream-rules', key: 'session' }, async ($, e, next) => {
      const result = await next(e)
      if (!held && e.value.value.corrections === 1) {
        held = true
        claimReached()
        await resume
      }
      return result
    })
    await start($)
    const running = turn($, w, 't1', [text('All tests pass.')])
    await claimed
    await cmd($, 'off')
    release()
    await running
    expect(w.submits).toEqual([])
  })

  test('newer input after a prose claim is checked before aborting', async ($, on) => {
    const w = world(on, { files: { [`${USER_DIR}/banana.md`]: BANANA } })
    const { promise: claimed, resolve: claimReached } = gate()
    const { promise: resume, resolve: release } = gate()
    let held = false
    on('state.set', { plugin: 'stream-rules', key: 'session' }, async ($, e, next) => {
      const result = await next(e)
      if (!held && e.value.value.corrections === 1) {
        held = true
        claimReached()
        await resume
      }
      return result
    })
    await start($)
    const running = turn($, w, 't1', [text('banana')], 'aborted')
    await claimed
    await $.prompt.submit({ text: 'New task.', wait: false, origin: { kind: 'composer' } })
    release()
    await running
    expect(w.aborts).toEqual([])
    expect(w.submits).toEqual(['New task.'])
  })

  test('newer input after a judgment claim but before delivery adds no reminder', async ($, on) => {
    const w = world(on, { files: { [`${USER_DIR}/judged.md`]: JUDGED }, judge: () => ({ isAnswered: true, text: 'yes', usage: USAGE }) })
    const { promise: claimed, resolve: claimReached } = gate()
    const { promise: resume, resolve: release } = gate()
    let held = false
    on('state.set', { plugin: 'stream-rules', key: 'session' }, async ($, e, next) => {
      const result = await next(e)
      const fired = e.value.value.fired as Record<string, Record<string, number>>
      if (!held && fired.main?.judged !== undefined) {
        held = true
        claimReached()
        await resume
      }
      return result
    })
    await start($)
    const running = turn($, w, 't1', [text('All tests pass.')])
    await claimed
    await $.prompt.submit({ text: 'New task.', wait: false, origin: { kind: 'composer' } })
    release()
    await running
    expect(w.appended()).toEqual([])
  })

  test('when a superseded claim skips the abort, the reply goes on whole', async ($, on) => {
    const w = world(on, { files: { [`${USER_DIR}/banana.md`]: BANANA } })
    const { promise: claimed, resolve: claimReached } = gate()
    const { promise: resume, resolve: release } = gate()
    let held = false
    on('state.set', { plugin: 'stream-rules', key: 'session' }, async ($, e, next) => {
      const result = await next(e)
      if (!held && e.value.value.corrections === 1) {
        held = true
        claimReached()
        await resume
      }
      return result
    })
    await start($)
    w.stream([text('a banana'), text(' split')])
    await $.turn.start({ text: 'go', turnId: 't1' })
    const out = step($, 't1')
    await claimed
    await $.prompt.submit({ text: 'New task.', wait: false, origin: { kind: 'composer' } })
    release()
    expect(shown(await out)).toBe('a banana split')
    expect(w.aborts).toEqual([])
  })

  test('a scheduled trigger supersedes a pending correction', async ($, on) => {
    const w = world(on, { files: { [`${USER_DIR}/banana.md`]: BANANA } })
    await start($)
    w.stream([text('banana')])
    await $.turn.start({ text: 'go', turnId: 't1' })
    await step($, 't1')
    await $.prompt.submit({ text: 'loop tick', wait: false, origin: { kind: 'scheduled-trigger' } })
    await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: true, reason: 'aborted' })
    await w.clock.settle()
    expect(w.submits).toEqual(['loop tick'])
  })

  test('a lower tool denial does not consume undelivered passive guidance', async ($, on) => {
    const passive = "---\ncondition: 'touch'\nscope: ['tool:Bash']\ninterrupt: false\nrepeat: once\n---\nPASSIVE MESSAGE\n"
    world(on, { files: { [`${USER_DIR}/passive.md`]: passive }, toolDenyFirst: true })
    await start($)
    const denied = await $.tool.call({ tool: 'Bash', command: 'touch a' })
    const allowed = await $.tool.call({ tool: 'Bash', command: 'touch b' })
    expect(`${denied.deny ?? ''}\n${allowed.context?.join('\n') ?? ''}`).toContain('PASSIVE MESSAGE')
  })

  test('querying status neither supersedes correction nor resets the cap', async ($, on) => {
    const w = world(on, { files: { [`${USER_DIR}/banana.md`]: BANANA.replace('scope: [text]', 'scope: [text]\nrepeat: always') } })
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    w.stream([text('banana')])
    await step($, 't1')
    expect((await cmd($, 'status')).text).toContain('1 of 2 corrections')
    await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: true, reason: 'aborted' })
    await w.clock.settle()
    expect(w.submits).toHaveLength(1)
    expect((await cmd($, 'status')).text).toContain('1 of 2 corrections')
  })
})

describe('tool routing', () => {
  const ON = { options: { toolRouting: true } }
  const bash = ($: any, command: string, extra: Record<string, unknown> = {}) => $.tool.call({ tool: 'Bash', command, ...extra })

  test('off by default: no bundled rule loads and cat runs', async ($, on) => {
    const w = world(on)
    await start($)
    expect((await bash($, 'cat README.md')).deny).toBeUndefined()
    expect(w.ran).toEqual(['Bash'])
    expect((await cmd($, 'list')).text).not.toContain('tool-routing-read')
    expect((await cmd($, 'status')).text).toContain('Tool routing: off')
  })

  test('opted in, cat is refused before it runs with a usable Read call; main loop and subagents', ON, async ($, on) => {
    const w = world(on)
    await start($)
    const r = await bash($, 'cat README.md')
    expect(r.deny).toContain('Read({ file_path: "/absolute/path/to/file", offset: 1, limit: 80 })')
    expect(r.deny).toContain('[tool-routing bypass] ')
    expect(r.deny).not.toContain('README.md')
    const sub = await bash($, "sed -i '' 's/a/b/' x.md", { agentId: 'a1' })
    expect(sub.deny).toContain('Edit({ file_path: "/absolute/path/to/file", old_string:')
    expect(w.ran).toEqual([])
  })

  test('commands routing leaves alone reach the tool once, unchanged', ON, async ($, on) => {
    const w = world(on)
    await start($)
    for (const command of ['cat README.md | wc -l', 'cat "$(pick)"', 'tail -f log', 'git status']) {
      expect((await bash($, command)).deny).toBeUndefined()
    }
    expect(w.inputs.map(i => (i as { command: string }).command)).toEqual(['cat README.md | wc -l', 'cat "$(pick)"', 'tail -f log', 'git status'])
    expect((await cmd($, 'status')).text).toContain('1 Bash call not analyzed (last: command substitution)')
  })

  test('search and file routing stay off when the session has no Grep or Glob tool', ON, async ($, on) => {
    const w = world(on)
    await start($)
    expect((await bash($, 'grep foo file.txt')).deny).toBeUndefined()
    expect((await bash($, "find src -name '*.ts'")).deny).toBeUndefined()
    expect(w.ran).toEqual(['Bash', 'Bash'])
    const status = (await cmd($, 'status')).text
    expect(status).toContain('Grep tool not available on this Claude Code; search routing off')
    expect(status).toContain('Glob tool not available on this Claude Code; file routing off')
    expect(status).toContain('active: tool-routing-edit (Edit), tool-routing-read (Read)')
  })

  test('with a Grep tool present, search routing acts', { options: { toolRouting: true } }, async ($, on) => {
    const w = world(on, { tools: ['Bash', 'Read', 'Edit', 'Grep', 'Glob'] })
    await start($)
    expect((await bash($, 'grep foo file.txt')).deny).toContain('Grep tool')
    expect((await bash($, "find src -name '*.ts'")).deny).toContain('Glob tool')
    expect(w.ran).toEqual([])
  })

  test('the bypass skips routing only, needs a reason of at most 240 characters, and is counted', ON, async ($, on) => {
    const w = world(on, { files: { [`${USER_DIR}/no-rm.md`]: NO_RM } })
    await start($)
    expect((await bash($, 'head -c 16 a.bin && cat a.txt', { description: '[tool-routing bypass] need the exact bytes' })).deny).toBeUndefined()
    expect((await bash($, 'cat a.txt', { description: '[tool-routing bypass]   ' })).deny).toContain('Read(')
    expect((await bash($, 'cat a.txt', { description: `[tool-routing bypass] ${'x'.repeat(241)}` })).deny).toContain('Read(')
    expect((await bash($, 'cat a.txt', { description: 'Show a file [tool-routing bypass] x' })).deny).toContain('Read(')
    const rm = await bash($, 'cat a && rm -rf b', { description: '[tool-routing bypass] cleanup' })
    expect(rm.deny).toContain('Use trash instead.')
    expect(w.ran).toEqual(['Bash'])
    expect((w.inputs[0] as { description: string }).description).toBe('[tool-routing bypass] need the exact bytes')
    expect((await cmd($, 'status')).text).toContain('2 bypassed')
    expect(w.logs.join('\n')).not.toContain('a.txt')
  })

  test('an ordinary refusal is the only message when both match', ON, async ($, on) => {
    const noCat = "---\ndescription: No cat\ncondition: '^cat '\nscope: ['tool:Bash']\n---\nAsk first.\n"
    world(on, { files: { [`${PROJECT_DIR}/no-cat.md`]: noCat } })
    await start($)
    const r = await bash($, 'cat a.txt')
    expect(r.deny).toContain('Ask first.')
    expect(r.deny).not.toContain('Read(')
  })

  test('a user file of the same name replaces or switches off a bundled rule', ON, async ($, on) => {
    const off = '---\nname: tool-routing-read\nmatcher: bash-native-read\nenabled: false\n---\nOff.\n'
    const mine = '---\nname: tool-routing-edit\nmatcher: bash-native-edit\n---\nUse Edit, please.\n'
    const w = world(on, { files: { [`${USER_DIR}/tool-routing-read.md`]: off, [`${PROJECT_DIR}/tool-routing-edit.md`]: mine } })
    await start($)
    expect((await bash($, 'cat a.txt')).deny).toBeUndefined()
    expect((await bash($, "sed -i '' s/a/b/ x")).deny).toContain('Use Edit, please.')
    expect(w.ran).toEqual(['Bash'])
    const list = (await cmd($, 'list')).text
    expect(list).toContain('tool-routing-read [disabled] (user, routes')
    expect(list).toContain('tool-routing-edit (project, routes')
    expect(list).toContain('tool-routing-search (bundled, routes')
    expect(list).toContain('matcher: bash-native-search, points to Grep')
  })

  test('a malformed matcher file is listed as a load error', async ($, on) => {
    world(on, { files: { [`${USER_DIR}/bad.md`]: "---\nmatcher: bash-native-cat\ncondition: 'cat'\n---\nx\n" } })
    await start($)
    expect((await cmd($, 'list')).text).toContain(`${USER_DIR}/bad.md: matcher must be`)
  })

  test('/stream-rules off lets routed commands run; on brings routing back', ON, async ($, on) => {
    const w = world(on)
    await start($)
    await cmd($, 'off')
    expect((await bash($, 'cat a.txt')).deny).toBeUndefined()
    await cmd($, 'on')
    expect((await bash($, 'cat a.txt')).deny).toContain('Read(')
    expect(w.ran).toEqual(['Bash'])
  })

  test('when the tool list fails, routing lets the call run and records why', ON, async ($, on) => {
    const w = world(on, { tools: 'fail' })
    await start($)
    expect((await bash($, 'cat a.txt')).deny).toBeUndefined()
    expect(w.ran).toEqual(['Bash'])
    expect((await cmd($, 'status')).text).toContain('could not list the tools')
  })

  test('/clear resets the routing counts', ON, async ($, on) => {
    world(on)
    await start($)
    await bash($, 'cat $X')
    expect((await cmd($, 'status')).text).toContain('1 Bash call not analyzed')
    await $.session.end({ reason: 'clear', sessionId: 'x', resume: { id: 'x' } })
    expect((await cmd($, 'status')).text).not.toContain('not analyzed')
  })

  test('test-tool Bash reports the matcher and the outcome', ON, async ($, on) => {
    world(on, { files: { [`${USER_DIR}/no-rm.md`]: NO_RM } })
    await start($)
    const read = (await cmd($, 'test-tool Bash cat README.md')).text
    expect(read).toContain('Matcher: understood; routes read')
    expect(read).toContain('tool-routing-read: matches; refuses and points to Read')
    expect(read).toContain('Would be refused by tool-routing-read.')
    const grep = (await cmd($, 'test-tool Bash grep foo a.txt')).text
    expect(grep).toContain("tool-routing-search: matches, but this session has no Grep tool, so it doesn't act")
    expect(grep).toContain('Would run.')
    expect((await cmd($, 'test-tool Bash cat "$(x)"')).text).toContain('Matcher: not analyzed (command substitution); routing lets it run')
    const rm = (await cmd($, 'test-tool Bash cat a && rm -rf b')).text
    expect(rm).toContain('Would be refused by no-rm.')
    expect((await cmd($, 'test-tool Edit x')).text).toContain('test-tool checks Bash commands only')
    expect((await cmd($, 'test-tool Bash')).text).toContain('test-tool needs a command')
  })
})

describe('tool routing review round 1', () => {
  const bash = ($: any, command: string, extra: Record<string, unknown> = {}) => $.tool.call({ tool: 'Bash', command, ...extra })
  const REQUIRE_READ = '---\nname: require-read\nmatcher: bash-native-read\n---\nThis project wants Read.\n'

  test('the bypass skips bundled routing only: a project matcher rule still refuses, option off', async ($, on) => {
    const w = world(on, { files: { [`${PROJECT_DIR}/require-read.md`]: REQUIRE_READ } })
    await start($)
    expect((await bash($, 'cat notes.txt')).deny).toContain('This project wants Read.')
    expect((await bash($, 'cat notes.txt', { description: '[tool-routing bypass] exact shell requested' })).deny).toContain('This project wants Read.')
    expect(w.ran).toEqual([])
  })
})
