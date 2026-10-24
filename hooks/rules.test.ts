import { describe, expect, test } from 'claude-code/testing'

import {
  compile,
  compileCondition,
  globMatches,
  matchText,
  MATCHERS,
  matchTool,
  matchToolCall,
  targetOf,
  mergeRules,
  parseFrontmatter,
  parseRule,
  projectTool,
} from './rules'
import { TOOL_ROUTING } from './ruleset'

const file = (front: string, body = 'Do the right thing.') => `---\n${front}\n---\n${body}\n`

const rule = (front: string, name = 'r.md', source: 'bundled' | 'user' | 'project' = 'user') => {
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

describe('quote errors', () => {
  test('an unclosed quote or text after the closing quote is a load error', async () => {
    const err = (front: string) => {
      const r = parseFrontmatter(file(front))
      return 'error' in r ? r.error : 'parsed'
    }
    expect(err("condition: '(?i)you're right'")).toContain('after the closing quote')
    expect(err("condition: 'abc")).toContain('quote is not closed')
    expect(err('condition: "abc')).toContain('quote is not closed')
    expect(err("scope: ['tool:Bash' x]")).toContain('after the closing quote')
    // the list ends at the first ] outside quotes; a comment may hold brackets, a quoted item may too
    const listed = parseFrontmatter(file("condition: ['foo', 'a]b'] # [case-sensitive]"))
    expect('error' in listed ? listed.error : listed.fields.condition).toEqual(['foo', 'a]b'])
    expect(err("condition: ['foo'] trailing")).toContain('after the closing ]')
    expect(err("condition: ['foo'")).toContain('not closed with ]')
    expect(err("condition: 'abc'  # fine")).toBe('parsed')
    expect(err("condition: 'you''re'")).toBe('parsed')
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

describe('routing rules (matcher)', () => {
  const bad = (front: string) => {
    const r = parseRule(file(front), 'b.md', 'user', '/rules/b.md')
    return 'error' in r ? r.error : 'parsed'
  }

  test('a matcher makes a routing rule scoped to Bash, with no condition', async () => {
    const r = rule('matcher: bash-native-read', 'tool-routing-read.md')
    expect(r.matcher).toBe('bash-native-read')
    expect(r.conditions).toEqual([])
    expect(r.scope).toEqual([{ kind: 'tool', tool: 'Bash' }])
    expect(rule("matcher: bash-native-edit\nscope: ['tool:Bash']").scope).toEqual([{ kind: 'tool', tool: 'Bash' }])
  })

  test('a malformed matcher field is a load error, never silently dropped', async () => {
    // Before 0.2.0 an unknown `matcher` beside a valid condition was ignored, so
    // the rule loaded as a plain regex rule.
    expect(bad("matcher: bash-native-read\ncondition: 'cat'")).toBe('a rule with a matcher takes no condition or question')
    expect(bad('matcher: bash-native-read\nquestion: Is it?')).toBe('a rule with a matcher takes no condition or question')
    expect(bad('matcher: bash-native-cat')).toBe('matcher must be bash-native-read, bash-native-edit, bash-native-search or bash-native-files')
    expect(bad("matcher: bash-native-cat\ncondition: 'cat'")).toBe('matcher must be bash-native-read, bash-native-edit, bash-native-search or bash-native-files')
    expect(bad('matcher: [bash-native-read, bash-native-edit]')).toBe('matcher must be bash-native-read, bash-native-edit, bash-native-search or bash-native-files')
    expect(bad("matcher: bash-native-read\nscope: [text]")).toBe('a rule with a matcher can only have the tool:Bash scope')
    expect(bad("matcher: bash-native-read\nscope: ['tool:Bash', text]")).toBe('a rule with a matcher can only have the tool:Bash scope')
    expect(bad("matcher: bash-native-read\nscope: ['tool:Bash(*.md)']")).toBe('a rule with a matcher can only have the tool:Bash scope')
  })

  test('a routing rule matches a Bash call by family, and reports what the matcher made of it', async () => {
    const rules = compile([
      rule('matcher: bash-native-read', 'read.md'),
      rule('matcher: bash-native-edit', 'edit.md'),
      rule("condition: 'rm -rf'\nscope: ['tool:Bash']", 'rm.md'),
    ])
    const call = (command: string) => matchToolCall(rules, 'Bash', { command })
    expect(call('cat a.md').hits.map(r => r.name)).toEqual(['read'])
    expect(call('cat a.md').analysis).toEqual({ kind: 'supported', families: ['read'] })
    expect(call("cat a.md; sed -i '' s/x/y/ b && rm -rf c").hits.map(r => r.name)).toEqual(['read', 'edit', 'rm'])
    expect(call('cat a.md | wc -l').hits).toEqual([])
    expect(call('cat "$(p)"').analysis?.kind).toBe('unsupported')
    expect(call('rm -rf "$(p)"').hits.map(r => r.name)).toEqual(['rm'])
    expect(matchToolCall(rules, 'Read', { file_path: '/a' }).analysis).toBeUndefined()
    // no routing rule loaded: the matcher isn't run
    expect(matchToolCall(compile([rule("condition: 'x'\nscope: ['tool:Bash']")]), 'Bash', { command: 'cat a' }).analysis).toBeUndefined()
    expect(matchTool(rules, 'Bash', { command: 'cat a.md' }).map(r => r.name)).toEqual(['read'])
  })

  test('a disabled routing rule matches nothing and skips the matcher', async () => {
    const rules = compile([rule('matcher: bash-native-read\nenabled: false', 'read.md')])
    expect(matchToolCall(rules, 'Bash', { command: 'cat a.md' })).toEqual({ hits: [] })
  })

  test('targets and families of each matcher', async () => {
    expect(MATCHERS.map(m => `${m}:${targetOf(m)}`)).toEqual(['bash-native-read:Read', 'bash-native-edit:Edit', 'bash-native-search:Grep', 'bash-native-files:Glob'])
  })

  test('precedence is bundled < user < project, by name', async () => {
    const merged = mergeRules([
      rule('matcher: bash-native-read', 'tool-routing-read.md', 'bundled'),
      rule('matcher: bash-native-edit', 'tool-routing-edit.md', 'bundled'),
      rule('matcher: bash-native-files', 'tool-routing-files.md', 'bundled'),
      rule('matcher: bash-native-read\nenabled: false', 'tool-routing-read.md', 'user'),
      rule("condition: 'sed'\nscope: ['tool:Bash']", 'tool-routing-edit.md', 'project'),
      rule('matcher: bash-native-files\nenabled: false', 'tool-routing-files.md', 'project'),
      rule('matcher: bash-native-files', 'tool-routing-files.md', 'user'),
    ])
    expect(merged.map(r => `${r.name}:${r.source}:${r.enabled}:${r.matcher ?? '-'}`)).toEqual([
      'tool-routing-edit:project:true:-',
      'tool-routing-files:project:false:bash-native-files',
      'tool-routing-read:user:false:bash-native-read',
    ])
  })
})

describe('the bundled ruleset', () => {
  test('each file loads as a bundled routing rule with a short message that names its tool', async () => {
    const loaded = Object.entries(TOOL_ROUTING).map(([name, text]) => {
      const r = parseRule(text, name, 'bundled', `/plugin/${name}`)
      if ('error' in r) throw new Error(`${name}: ${r.error}`)
      return r.rule
    })
    expect(loaded.map(r => `${r.name}:${r.matcher}`)).toEqual([
      'tool-routing-read:bash-native-read',
      'tool-routing-edit:bash-native-edit',
      'tool-routing-search:bash-native-search',
      'tool-routing-files:bash-native-files',
    ])
    for (const r of loaded) {
      expect(r.interrupt).toBe(true)
      expect(r.body.length).toBeLessThan(600)
      expect(r.body).toContain(`${targetOf(r.matcher!)} tool`)
      expect(r.body).toContain('"[tool-routing bypass] "')
      expect(/thinking|reasoning/i.test(r.body)).toBe(false)
    }
    const total = loaded.reduce((n, r) => n + r.body.length + r.description.length, 0)
    expect(total).toBeLessThan(2048)
  })
})
