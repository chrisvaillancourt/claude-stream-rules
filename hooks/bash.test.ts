import { describe, expect, test } from 'claude-code/testing'

import { MAX_BYTES, MAX_SEGMENTS, classifyBash } from './bash'

// The standing corpus: what tool routing makes of a Bash command. Frozen
// before the matcher was written; every false positive reported later becomes
// another row. Expected values:
//   read | edit | search | files   routed to that family (a list: several commands in one call)
//   pass                           understood, and nothing in it is routed
//   unsupported                    syntax the matcher doesn't model: the whole command passes routing
//   limit                          over the size or segment bound: the whole command passes routing
type Expected = 'pass' | 'unsupported' | 'limit' | string

const CORPUS: readonly (readonly [command: string, expected: Expected, why?: string])[] = [
  // readers
  ['cat README.md', 'read'],
  ['"cat" "a b.txt"', 'read', 'quotes removed before matching'],
  ['/bin/cat README.md', 'read'],
  ['/usr/bin/cat README.md', 'read'],
  ['LANG=C cat README.md', 'read', 'leading assignment stripped'],
  ['head -n 40 file.txt', 'read'],
  ['head -n40 file.txt', 'read'],
  ['head -40 file.txt', 'read'],
  ['head file.txt', 'read'],
  ['tail -n 40 file.txt', 'read'],
  ['tail -n +5 file.txt', 'read'],
  ['tail --lines=20 file.txt', 'read'],
  ['less file.txt', 'read'],
  ['more file.txt', 'read'],
  ['cat -- file.txt', 'read'],
  ["cat 'it''s'", 'read', 'two adjacent single-quoted parts are one word'],
  ['cat a\\ b.txt', 'read', 'escaped space'],
  ['cat a b', 'pass', 'concatenation'],
  ['cat file > copy', 'pass', 'copying'],
  ['cat file >> log', 'pass', 'appending'],
  ['cat > file', 'pass', 'writing stdin'],
  ['cat < file', 'pass', 'stdin redirect'],
  ['cat file 2>/dev/null', 'read', 'stderr redirect only'],
  ['cat <<EOF\nhello\nEOF', 'unsupported', 'heredoc'],
  ['tail -f app.log', 'pass', 'following'],
  ['tail -F app.log', 'pass', 'following'],
  ['tail --follow app.log', 'pass', 'following'],
  ['head -c 16 image.bin', 'pass', 'byte semantics'],
  ['cat /dev/urandom', 'pass', 'device'],
  ['cat -', 'pass', 'stdin'],
  ['cat', 'pass', 'stdin'],
  ['cat -n file.txt', 'pass', 'unknown option for the closed grammar'],
  ['cat *.md', 'pass', 'unquoted glob is not one literal file'],
  ['cat {a,b}.md', 'pass', 'brace expansion is not one literal file'],
  ['cat ~/notes.md', 'pass', 'tilde expansion is not a literal path'],
  ['./cat file', 'pass', 'not a known path to cat'],
  ['bat file', 'pass'],
  ['catalog file', 'pass'],

  // pipelines and sequencing
  ['git log | grep foo', 'pass'],
  ['ps aux | grep x', 'pass'],
  ['cmd | head -5', 'pass'],
  ['git log |\n# a comment\ngrep foo', 'pass', 'comment inside a pipeline continuation'],
  ['git log |&\ngrep foo', 'pass'],
  ['cat file | wc -l', 'pass', 'pipeline producer'],
  ['rg -c foo src | jq -R .', 'pass'],
  ['rg foo src | wc -l', 'pass'],
  ['echo ok && cat file', 'read'],
  ['cmd | head -5 && cat file', 'read'],
  ['false || cat file', 'read'],
  ['cd src; cat file', 'read'],
  ['cat file &', 'read'],
  ['echo a\ncat file', 'read', 'newline separates commands'],
  ['cat a.md && sed -i "" s/x/y/ b.md', 'read,edit'],
  ['echo "x; cat file"', 'pass', 'operator inside quotes'],
  ["echo 'cat file' && echo done", 'pass'],
  ['cat file # $(ignored)', 'read', 'comment ignored'],
  ['echo a#b', 'pass', '# inside a word is not a comment'],
  ['cat a\\\n.md', 'read', 'line continuation'],

  // unsupported syntax: the whole command passes
  ["printf '%s' \"$(cat file)\"", 'unsupported', 'nested execution'],
  ['cat "$(get_path)"', 'unsupported', 'expansion'],
  ['cat `get_path`', 'unsupported', 'backticks'],
  ['cat $FILE', 'unsupported', 'variable'],
  ['cat "${FILE}"', 'unsupported', 'variable in double quotes'],
  ['diff <(cat a) <(cat b)', 'unsupported', 'process substitution'],
  ['(cat file)', 'unsupported', 'subshell'],
  ['{ cat file; }', 'unsupported', 'group'],
  ['if grep -q foo file; then echo yes; fi', 'unsupported', 'control flow'],
  ['for f in a b; do cat $f; done', 'unsupported', 'control flow'],
  ['! cat file', 'unsupported', 'negation'],
  ['cat "unclosed', 'unsupported', 'malformed quote'],
  ["cat 'unclosed", 'unsupported', 'malformed quote'],
  ['cat file\\', 'unsupported', 'trailing backslash'],
  ["echo '$(not run)' && cat file", 'read', '$ inside single quotes is literal'],
  ['echo $ && cat file', 'read', 'a lone $ is literal'],

  // search
  ['grep foo file.txt', 'search'],
  ['rg foo src', 'search'],
  ['rg foo', 'search'],
  ['grep -rn foo src', 'search'],
  ['grep -e foo -i file.txt', 'search'],
  ["rg -g '*.ts' foo src", 'search'],
  ['rg --count foo src', 'pass', 'count mode is left to Bash'],
  ['grep -c foo file.txt', 'pass', 'count mode'],
  ['grep -q foo file && echo yes', 'pass', 'predicate'],
  ['grep --help', 'pass'],
  ['grep -V', 'pass'],
  ['grep foo', 'pass', 'stdin'],
  ['grep foo < file.txt', 'pass', 'redirected input'],
  ['grep foo file.txt > hits', 'pass', 'redirected output'],
  ['grep -P foo file.txt', 'pass', 'unknown option'],

  // discovery
  ["find src -name '*.ts' -type f", 'files'],
  ["find . -iname '*.MD'", 'files'],
  ["fd -g '*.ts' -t f src", 'files'],
  ["fd --glob '*.ts'", 'files'],
  ['ls -R src', 'files'],
  ['ls -R', 'files'],
  ['ls -lR src', 'pass', 'metadata'],
  ['ls src', 'pass'],
  ['find . -type d', 'pass', 'directory results'],
  ['find . -type f', 'pass', 'no name pattern'],
  ["find . -name '*.ts' -print0 | xargs -0 wc -l", 'pass'],
  ["find . -name '*.ts' -print0", 'pass', 'NUL output'],
  ['find . -exec rm {} \\;', 'pass', 'action'],
  ["find . -name '*.log' -delete", 'pass', 'action'],
  ["find . -name '*.ts' -newer x", 'pass', 'unknown primary'],
  ['fd foo src', 'pass', 'regex mode'],
  ["find src -name *.ts", 'pass', 'unquoted glob'],

  // edits
  ["sed -i '' 's/x/y/' file", 'edit'],
  ["sed -i 's/x/y/' file", 'edit', 'GNU form'],
  ["sed -i.bak 's/x/y/' file", 'edit'],
  ["sed -n -i 's/x/y/' file", 'edit'],
  ["sed -ni 's/x/y/' file", 'edit'],
  ["sed -E -i '' -e 's/x/y/' file", 'edit'],
  ["sed --in-place 's/x/y/' file", 'edit'],
  ["sed --in-place=.bak 's/x/y/' file", 'edit'],
  ["sed 's/x/y/' file", 'pass'],
  ["sed -n 's/x/y/p' file", 'pass'],
  ["sed -i -f script.sed file", 'pass', 'script file'],
  ["sed -i 's/x/y/'", 'pass', 'no file'],
  ["sed 's/-i/x/' file", 'pass', 'option-looking script'],
  ["perl -pi -e 's/x/y/' file", 'edit'],
  ["perl -i -pe 's/x/y/' file", 'edit'],
  ["perl -pi.bak -e 's/x/y/' file", 'edit'],
  ["perl -e 'print \"-pi\"'", 'pass'],
  ["perl -pe 's/x/y/' file", 'pass', 'not in place'],
  ['perl -pi script.pl file', 'pass', 'script file'],
  ["awk -i inplace '{print}' file", 'edit'],
  ["gawk -i inplace -v n=1 '{print}' file", 'edit'],
  ["awk '{print}' file", 'pass'],
  ["awk -i inplace -f prog.awk file", 'pass', 'script file'],

  // other commands are left alone
  ['ls', 'pass'],
  ['git status', 'pass'],
  ['', 'pass'],
  ['   ', 'pass'],
  ['sudo cat /etc/hosts', 'pass', 'wrappers are out of contract'],
  ["bash -c 'cat file'", 'pass', 'nested shells are out of contract'],
]

const describeResult = (command: string): string => {
  const c = classifyBash(command)
  if (c.kind !== 'supported') return c.kind
  return c.families.length === 0 ? 'pass' : c.families.join(',')
}

describe('classifyBash: the standing corpus', () => {
  test('every row classifies as expected', () => {
    const wrong = CORPUS.filter(([cmd, want]) => describeResult(cmd) !== want).map(([cmd, want, why]) => ({ cmd, want, got: describeResult(cmd), why }))
    expect(wrong).toEqual([])
  })

  test('an unsupported result names why, without the command', () => {
    const c = classifyBash('cat "$(secret-path)"')
    expect(c.kind).toBe('unsupported')
    if (c.kind === 'unsupported') {
      expect(c.reason).toContain('substitution')
      expect(c.reason).not.toContain('secret-path')
    }
  })
})

describe('classifyBash: bounds', () => {
  test('over 64 KiB is a limit, not analyzed', () => {
    expect(classifyBash(`cat ${'a'.repeat(MAX_BYTES)}`).kind).toBe('limit')
    expect(MAX_BYTES).toBe(64 * 1024)
  })

  test('over 256 commands is a limit', () => {
    expect(MAX_SEGMENTS).toBe(256)
    expect(classifyBash(Array.from({ length: MAX_SEGMENTS }, () => 'true').join('; ')).kind).toBe('supported')
    expect(classifyBash(Array.from({ length: MAX_SEGMENTS + 1 }, () => 'true').join('; ')).kind).toBe('limit')
  })

  test('a large ordinary command finishes quickly', () => {
    const big = Array.from({ length: 200 }, (_, i) => `echo "${'x'.repeat(200)}${i}"`).join(' && ')
    const t0 = Date.now()
    expect(describeResult(big)).toBe('pass')
    expect(Date.now() - t0).toBeLessThan(200)
  })
})
