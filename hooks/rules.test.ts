import { describe, expect, test } from 'claude-code/testing'

import {
  compile,
  compileCondition,
  globMatches,
  matchText,
  matchTool,
  mergeRules,
  parseFrontmatter,
  parseRule,
  projectTool,
} from './rules'

const file = (front: string, body = 'Do the right thing.') => `---\n${front}\n---\n${body}\n`

const rule = (front: string, name = 'r.md', source: 'user' | 'project' = 'user') => {
  const r = parseRule(file(front), name, source, `/rules/${name}`)
  if ('error' in r) throw new Error(r.error)
  return r.rule
}

describe('frontmatter', () => {
  test('reads scalars, quoted strings, inline lists and dash lists', async () => {
    const r = parseFrontmatter(
      file(
        [
          'description: No bananas # trailing comment',
          "condition: '\\bbanana\\b'",
          "scope: [text, 'tool:Edit(*.ts)']",
          'globs:',
          '  - a',
          '  - "b c"',
          'interrupt: false',
          'gap: 4',
        ].join('\n'),
      ),
    )
    if ('error' in r) throw new Error(r.error)
    expect(r.fields.description).toBe('No bananas')
    expect(r.fields.condition).toBe('\\bbanana\\b')
    expect(r.fields.scope).toEqual(['text', 'tool:Edit(*.ts)'])
    expect(r.fields.globs).toEqual(['a', 'b c'])
    expect(r.fields.interrupt).toBe(false)
    expect(r.fields.gap).toBe(4)
    expect(r.body).toBe('Do the right thing.')
  })

  test('a file without frontmatter is an error', async () => {
    expect(parseFrontmatter('just text')).toEqual({ error: 'no frontmatter (the file must start with ---)' })
    expect(parseFrontmatter('---\nname: x\n')).toEqual({ error: 'frontmatter is not closed with ---' })
  })
})

describe('parseRule', () => {
  test('fills defaults and takes the name from the file', async () => {
    const r = rule("condition: 'x'", 'no-x.md')
    expect(r.name).toBe('no-x')
    expect(r.scope).toEqual([{ kind: 'text' }, { kind: 'tool' }])
    expect(r.interrupt).toBe(true)
    expect(r.repeat).toBe(null)
    expect(r.gap).toBe(10)
    expect(r.enabled).toBe(true)
    expect(r.body).toBe('Do the right thing.')
  })

  test('parses every scope form, prose as an alias of text', async () => {
    const r = rule("condition: 'x'\nscope: [prose, thinking, tool, 'tool:Bash', 'tool:Edit(**/*.ts)']")
    expect(r.scope).toEqual([
      { kind: 'text' },
      { kind: 'thinking' },
      { kind: 'tool' },
      { kind: 'tool', tool: 'Bash' },
      { kind: 'tool', tool: 'Edit', glob: '**/*.ts' },
    ])
  })

  test('rejects what it cannot enforce, naming the problem', async () => {
    const bad = (front: string) => {
      const r = parseRule(file(front), 'b.md', 'user', '/rules/b.md')
      return 'error' in r ? r.error : 'parsed'
    }
    expect(bad('description: nothing')).toBe('a rule needs a condition or a question')
    expect(bad("condition: '('")).toContain('condition 1 is not a valid regex')
    expect(bad("condition: 'x'\nscope: [elsewhere]")).toBe('unknown scope: elsewhere')
    expect(bad("condition: 'x'\nrepeat: sometimes")).toBe('repeat must be once, always or after-gap')
    expect(bad("condition: 'x'\nname: 'has space'")).toBe('name must be letters, digits, - and _')
    const empty = parseRule(`---\ncondition: 'x'\n---\n  \n`, 'e.md', 'user', '/e')
    expect('error' in empty ? empty.error : '').toBe('the rule has no body (the message the model is given)')
  })
})

describe('conditions', () => {
  test('leading (?i), (?m), (?s) become flags', async () => {
    const re = compileCondition('(?im)^banana')
    if (!(re instanceof RegExp)) throw new Error(re.error)
    expect(re.flags).toContain('i')
    expect(re.flags).toContain('m')
    expect(re.test('apple\nBANANA')).toBe(true)
    const plain = compileCondition('banana')
    expect(plain instanceof RegExp && plain.test('BANANA')).toBe(false)
  })
})

describe('quoting', () => {
  test("a doubled quote inside single quotes is one quote", async () => {
    const r = rule("condition: '(?i)\\b(you''re|you are) absolutely right\\b'")
    expect(compile([r])[0]!.regexes[0]!.test("You're absolutely right!")).toBe(true)
  })
})

describe('globs', () => {
  test('match the path or the file name', async () => {
    expect(globMatches('*.ts', '/x/src/a.ts')).toBe(true)
    expect(globMatches('*.ts', '/x/src/a.md')).toBe(false)
    expect(globMatches('src/**/*.ts', 'src/deep/er/a.ts')).toBe(true)
    expect(globMatches('**/*.{ts,tsx}', '/x/a.tsx')).toBe(true)
    expect(globMatches('a?.ts', 'ab.ts')).toBe(true)
    expect(globMatches('*.ts', 'C:\\x\\a.ts')).toBe(true)
  })
})

describe('projectTool', () => {
  test('reads what the tool will add, never what it removes', async () => {
    expect(projectTool('Bash', { command: 'rm -rf x' })).toEqual({ text: 'rm -rf x' })
    expect(projectTool('Edit', { file_path: '/a.ts', old_string: 'any', new_string: 'unknown' })).toEqual({ text: 'unknown', path: '/a.ts' })
    expect(projectTool('Write', { file_path: '/a.ts', content: 'c' })).toEqual({ text: 'c', path: '/a.ts' })
    expect(projectTool('NotebookEdit', { notebook_path: '/n.ipynb', new_source: 's' })).toEqual({ text: 's', path: '/n.ipynb' })
    expect(projectTool('mcp__x__y', { q: 1, path: '/p' })).toEqual({ text: '{"q":1,"path":"/p"}', path: '/p' })
  })
})

describe('matching', () => {
  test('text rules match text, not thinking unless scoped, and never judged rules', async () => {
    const rules = compile([
      rule("condition: 'banana'", 'a.md'),
      rule("condition: 'banana'\nscope: [thinking]", 'b.md'),
      rule("condition: 'banana'\nquestion: Is it yellow?", 'c.md'),
      rule("condition: 'banana'\nenabled: false", 'd.md'),
    ])
    expect(matchText(rules, 'text', 'a banana').map(r => r.name)).toEqual(['a'])
    expect(matchText(rules, 'thinking', 'a banana').map(r => r.name)).toEqual(['b'])
    expect(matchText(rules, 'text', 'an apple')).toEqual([])
  })

  test('tool rules match by tool name and path glob', async () => {
    const rules = compile([
      rule("condition: 'any'\nscope: ['tool:Edit(*.ts)']", 'ts.md'),
      rule("condition: 'rm -rf'\nscope: ['tool:Bash']", 'rm.md'),
      rule("condition: 'secret'\nscope: [tool]", 'all.md'),
      rule("condition: 'any'\nscope: [text]", 'prose.md'),
    ])
    const names = (tool: string, input: unknown) => matchTool(rules, tool, input).map(r => r.name)
    expect(names('Edit', { file_path: '/x/a.ts', old_string: '', new_string: 'x: any' })).toEqual(['ts'])
    expect(names('Edit', { file_path: '/x/a.md', old_string: '', new_string: 'x: any' })).toEqual([])
    expect(names('Edit', { file_path: '/x/a.ts', old_string: 'x: any', new_string: '' })).toEqual([])
    expect(names('bash', { command: 'rm -rf /tmp/x' })).toEqual(['rm'])
    expect(names('Read', { file_path: '/secret' })).toEqual(['all'])
    expect(names('mcp__s__t', { a: 'secret' })).toEqual(['all'])
  })
})

describe('mergeRules', () => {
  test('a project rule replaces the user rule of the same name; a disabled one hides it', async () => {
    const merged = mergeRules([
      rule("condition: 'u'", 'same.md', 'user'),
      rule("condition: 'u'", 'gone.md', 'user'),
      rule("condition: 'u'", 'mine.md', 'user'),
      rule("condition: 'p'", 'same.md', 'project'),
      rule("condition: 'p'\nenabled: false", 'gone.md', 'project'),
    ])
    expect(merged.map(r => `${r.name}:${r.source}:${r.enabled}`)).toEqual(['gone:project:false', 'mine:user:true', 'same:project:true'])
  })
})
