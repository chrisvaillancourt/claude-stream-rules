# stream-rules

A Claude Code mod that enforces your rules while the model works, instead of hoping it remembers a line in CLAUDE.md. Each rule is a small markdown file with a regex (or a yes/no question). When the model's streamed reply or a tool call matches, the mod stops it and gives the model the rule: a tool call is refused before it runs, and a reply is cut off and followed by a corrective turn.

It is a partial port of oh-my-pi's "time traveling stream rules" to the Claude Code mod API. The biggest difference: Claude Code can't roll the transcript back, so the text shown before a match stays, and the correction comes as a new turn. It also leaves out several oh-my-pi features (structural AST conditions, the bundled language rules and more); [Limitations](#limitations) lists them.

## Behavior

- **Tool calls** (main conversation and subagents): a call whose input matches an interrupting rule is refused with the rule's text, and the tool never runs. A non-interrupting rule lets the call run and adds the rule's text after the result, where only the model reads it. When both kinds match one call, the refusal carries all their texts. If something else refuses the call (a permission rule, another plugin), the note is added to that refusal.
- **Replies on the main conversation**: the reply is checked as it streams (a match split across chunks is still found). On an interrupting match the mod stops the reply at that point, cancels the turn, and submits a corrective prompt carrying the rule. Text shown before the match stays on screen and in the transcript. Tool calls the model had started in that reply are dropped, so they never run.
- **Replies in subagents**: a subagent's turn can't be cancelled from a mod, so a match adds the rule as a reminder the subagent reads on its next request. Non-interrupting rules do the same on the main conversation.
- **Judged rules** (`question`): after a main-conversation turn ends with an answer, a cheap model is asked the rule's yes/no question about the final answer. A yes adds the rule as a reminder for the next request (or, with `judgeAction: correct`, starts a corrective turn). Off unless a rule has a `question`.
- **Bounds**: at most `maxCorrections` corrective turns per prompt you send; each rule's `repeat` policy keeps one rule from firing over and over.
- **Your newer input wins.** A correction or a judged rule's follow-up belongs to the prompt it came from. When new work arrives before it is delivered, or you run `/stream-rules on|off` or `/clear`, it is dropped and logged, never sent into the new task. What counts as new work:

  | Arrives | Effect on a pending correction or judgment |
  | --- | --- |
  | A prompt you type or send (terminal, `claude -p`/SDK, Remote Control, Slack and other channels) | dropped; the corrections count starts over |
  | Any slash command except `/stream-rules` and `/stream-rules-draft` (skills and prompt commands start model work) | dropped; count starts over |
  | A scheduled task or `/loop` firing, another plugin's prompt, a coordinator hand-off, anything unrecognized | dropped; count starts over |
  | A background task's notification, a teammate's or another session's report, an observer's update | kept: it is context for the work in hand |
  | This mod's own corrective prompt | kept |
- It never writes a rule file on its own, never edits your settings, and never puts rules in the system prompt (they cost no tokens until one fires).

## Rule files

Rules are read when a session starts (and on `/stream-rules reload`) from:

- `~/.claude/stream-rules/*.md`: yours, for every project.
- `<project>/.claude/stream-rules/*.md`: the project's. A project rule with the same name replaces your own.
- With the `toolRouting` option on, the mod's four bundled routing rules (in `hooks/ruleset.ts`; `/stream-rules list` prints their text) too, below both: a rule of yours with the same name replaces a bundled one.

They are deliberately not in `.claude/rules/`, which Claude Code loads into the prompt itself.

```markdown
---
description: Don't hand back work with a TODO left in it
condition: '(?i)\bTODO\b'
scope: ['tool:Edit(*.ts)', 'tool:Write(*.ts)']
---
Finish the code instead of leaving a TODO. If something truly can't be done now, say so in the reply.
```

The body is the message the model is given. Frontmatter fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `name` | the file name | Identity. Letters, digits, `-`, `_`. |
| `description` | none | One line, shown in `/stream-rules list` and to the model. |
| `condition` | none | A regex, or a list of them (any one matches). A leading `(?i)`, `(?m)` or `(?s)` sets the flags. Write regexes in single quotes (`''` for a quote inside). |
| `scope` | `[text, tool]` | Where to look: `text` (alias `prose`, the reply), `thinking` (the thinking the model streams, when it streams any), `tool` (any tool's input), `tool:Bash` (one tool), `tool:Edit(*.ts)` (one tool on paths matching a glob; `*`, `**`, `?`, `{a,b}`, matched against the path and the file name). |
| `interrupt` | `true` | `false` turns a stop into a reminder (prose) or a note after the result (tools). |
| `repeat` | `once` for prose, `always` for tools | `once`: fires once per session; `always`: every match; `after-gap`: again after `gap` model responses in that conversation. |
| `gap` | `10` | Model responses between firings for `after-gap`. |
| `question` | none | Makes the rule judged: a yes/no question about the final answer (yes means the rule was broken). `condition`, if given, must match the answer first. |
| `matcher` | none | Makes the rule a tool-routing rule: `bash-native-read`, `bash-native-edit`, `bash-native-search` or `bash-native-files` ([Tool routing](#tool-routing-opt-in)). Not with `condition` or `question`. |
| `enabled` | `true` | `false` turns the rule off, and hides a user (or bundled) rule of the same name. |

What the mod reads of a tool call: `Bash` its `command`; `Edit` its `new_string` (never `old_string`, so deleting a pattern doesn't trip a rule against adding it); `Write` its `content`; `NotebookEdit` its `new_source`; any other tool its input as JSON. Path globs read `file_path`, `notebook_path` or `path`.

Values are single-line. `[a, b]` and `- item` lists both work, and a ` # comment` may follow a value. An unclosed quote, or text after a closing quote or `]`, is a load error rather than a guess. A file that fails to parse is skipped and listed with its error in `/stream-rules list`.

The `examples/` folder has one rule per kind. None is loaded until you copy it into a rules folder:

- `no-rm-rf.md`: refuses `rm -rf` in Bash (tool, stops).
- `ts-no-any.md`: a note after an Edit or Write that adds `any` to a `.ts`/`.tsx` file (tool path glob, reminds, `after-gap`).
- `no-flattery.md`: stops a reply that opens with "you're absolutely right" (text, stops).
- `show-test-output.md`: asks the judge whether a reply claims tests pass without showing output (judged).

## Tool routing (opt-in)

Models often read and edit files through Bash (`cat file`, `sed -i`) when Claude Code has a tool built for it. Turn on the `toolRouting` option and the mod refuses those Bash calls before they run and names the tool to use instead:

| Rule (bundled) | `matcher` | Refuses | Points to |
| --- | --- | --- | --- |
| `tool-routing-read` | `bash-native-read` | `cat file`, `less file`, `more file`, `head -n 40 file`, `tail -n 40 file` | `Read({file_path: "/abs/path", offset: 1, limit: 80})` |
| `tool-routing-edit` | `bash-native-edit` | `sed -i …`, `perl -pi -e … file`, `awk -i inplace … file` | `Read`, then `Edit({file_path, old_string, new_string})` |
| `tool-routing-search` | `bash-native-search` | `grep pattern file`, `rg pattern [path]` | the Grep tool, **only when the session has one** |
| `tool-routing-files` | `bash-native-files` | `find path -name '*.ts' [-type f]`, `fd -g '*.ts' [-t f]`, `ls -R` | the Glob tool, **only when the session has one** |

Claude Code 2.1.310 has no Grep or Glob tool: search and file finding go through Bash. So on that release only the read and edit rules act, and `/stream-rules status` says "Grep tool not available on this Claude Code; search routing off" (and the same for Glob). The mod never tells the model to call a tool the session doesn't have.

What is refused is deliberately narrow. A command is routed only when the whole of one command in it is a plain, recognized form, and anything the matcher doesn't fully understand runs untouched:

- **Pipelines run.** `cat file | wc -l`, `git log | grep foo`, `find . -name '*.ts' -print0 | xargs -0 wc -l`: every stage of a pipeline is left alone, because a native tool's output is not a byte stream.
- **Other semantics run.** Concatenation (`cat a b`), copies and writes (`cat file > copy`, `cat > file`), heredocs, following (`tail -f`), bytes (`head -c 16`), stdin and devices (`cat -`, `cat /dev/urandom`), quiet and count modes (`grep -q`, `grep -c`, `rg --count`), `--help`, a plain `sed` that prints, `ls -lR`, `find -type d`, `find -exec`, and any option the matcher doesn't know.
- **Unsupported shell runs, whole.** `$VAR` and other expansions, `$(…)`, backticks, heredocs, `( … )` and `{ … }` groups, `if`/`for`/`while` and other control flow, process substitution and unclosed quotes make routing skip the entire command (it counts them in `/stream-rules status`). It never guesses with a regex.
- **Understood:** quotes and escapes (`"cat" "a b.txt"`), comments, `NAME=value` prefixes, `/bin/cat` and `/usr/bin/cat`, and commands joined by `;`, `&&`, `||`, `&` or newlines (`echo ok && cat file` is refused for its `cat`).
- Main conversation and subagents alike. Your own rules come first: when an ordinary rule of yours refuses the call, its message is the only one given.

**Escape hatch.** When the shell form is really needed (you asked for that exact command, say), the model runs it again with a Bash `description` that starts with `[tool-routing bypass] ` followed by its reason (at most 240 characters). That skips the bundled routing rules only, never a routing rule you or the project wrote (even one that replaces a bundled rule by name), your other rules, or Claude Code's permissions. The refusal tells the model how. Bypasses are counted in `/stream-rules status`; the command isn't recorded.

**Changing or turning off one rule.** A file of the same name in `~/.claude/stream-rules/` or `<project>/.claude/stream-rules/` replaces the bundled one (project over user over bundled). To switch one off:

```markdown
---
name: tool-routing-read
matcher: bash-native-read
enabled: false
---
Off.
```

**Contract.** In scope: literal, flat shell commands; quotes and escapes; comments; `NAME=value` prefixes; sequencing with `;`, `&&`, `||`, `&` and newlines; recognizing pipelines; and the option forms listed above. Out of contract: nested execution (`$(…)`, `bash -c`, `eval`), control flow, shell wrappers and interpreters (`sudo`, `env`, `xargs`, `nice`), aliases and functions, any expansion, Windows shells, scripts, checking the filesystem (FIFOs, symlinks, binary files), and stopping a model that sets out to evade it. Out-of-contract input is left to run and is never reported as analyzed. The standing corpus in `hooks/bash.test.ts` pins every case; a false positive you report becomes a new row.

You can also write your own routing rules: `matcher` takes one of the four values above, with your own message as the body. They act whether or not `toolRouting` is on, and the bypass doesn't skip them. A routing rule has no `condition` or `question`, and its scope can only be `tool:Bash` (the default for it). Any other combination, or an unknown `matcher`, is a load error listed in `/stream-rules list`.

## Commands

`/stream-rules [status|list|test <text>|test-tool Bash <command>|on|off|reload|reset]`

- `status` (the default): on or off and why, how many rules loaded, corrections used, the last error; and tool routing's state: whether the option is on, which routing rules are active, which are off for want of their target tool, and how many Bash calls were unsupported, over the size limit or bypassed.
- `list`: every rule with its scope, conditions (or `matcher`) and source (`bundled`, `user`, `project`), then files that failed to load and why.
- `test <text>`: which rules match the text as a reply. Judged rules show whether their prefilter matched; the question isn't asked.
- `test-tool Bash <command>`: what the matcher makes of a Bash command and which rules would match it as a tool call: refused by which rule, or run. It ignores repeat state and the bypass.
- `on` / `off`: turn the mod on or off for this session.
- `reload`: read the rule folders again.
- `reset`: forget which rules have fired this session, so `once` rules can fire again.

`/stream-rules-draft <complaint> | show | save [project|user] [overwrite] | cancel`

Drafts a rule from a complaint ("it keeps saying 'you're absolutely right'"). The draft model reads your complaint and the recent conversation and writes a rule; the mod parses it with the same code that loads rules, runs it over the last 20 assistant messages with the same matcher live enforcement uses (replies for a `text` scope, the recorded tool calls for a `tool` scope, path globs included) and reports how many it matches (a rule that matches everything is a bad rule; history keeps no streamed thinking, so a `thinking` scope isn't checked), and shows the file. Nothing is written until you run `/stream-rules-draft save` (`project` by default, or `user`). Saving refuses to replace an existing file unless you add `overwrite`. A new draft replaces the one held.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Turn the mod on for new sessions. `/stream-rules on|off` overrides it per session. |
| `maxCorrections` | `2` | Corrective turns allowed per prompt you send. Past it, a match on a reply becomes a reminder and the reply goes on. `0` never stops a reply. |
| `judgeModel` | `haiku` | Model that answers judged rules' questions. |
| `judgeMaxPerTurn` | `3` | Judged questions asked after one turn, at most. |
| `judgeAction` | `remind` | `remind` adds the rule as a reminder after a yes; `correct` starts a corrective turn (counts toward `maxCorrections`). |
| `draftModel` | `haiku` | Model that drafts rules for `/stream-rules-draft`. |
| `toolRouting` | `false` | Load the bundled tool-routing rules ([Tool routing](#tool-routing-opt-in)). Read when a session starts and on `/stream-rules reload`. |

## What it costs

- Matching is local regex work: no model calls, no tokens.
- Tool routing is local too: one linear scan of the Bash command (capped at 64 KiB and 256 commands), and one `tool.list` lookup when a routing rule matches. A refusal is a short message (each bundled rule's text is under 600 characters) that the model reads, then a retry with the native tool: one more model response.
- A corrective turn is one more turn on your session's model. The conversation is only appended to, so the prompt cache still serves the earlier part.
- A judged rule costs one `judgeModel` call per main turn whose answer passes its prefilter, at most `judgeMaxPerTurn` a turn. Each call sends the question and up to 32,000 characters of the answer and asks for one word. These calls aren't counted in Claude Code's session cost.
- A draft is one `draftModel` call with your complaint and up to 20,000 characters of recent conversation.

## Limitations

- **No rollback.** Text shown before a match stays in the transcript, and the model sees it. A match split across chunks can leave the start of the matched text on screen (`The ban` when the rule matched `banana`).
- **Subagents can't be interrupted.** A reply match in a subagent becomes a reminder it reads on its next request; if the subagent is on its last response, the reminder lands too late. Tool rules do stop subagent tool calls.
- **Regex rules miss paraphrases.** Use a judged rule for fuzzy cases, and check new regexes against real output (the draft command does a first pass).
- **Not a security boundary.** A command that writes files from the shell isn't seen as an edit, tools the API runs itself can't be intercepted, and the tool guard fails open if the mod itself errors (the error is shown in `/stream-rules status`).
- **Headless runs** (`claude -p`): the run ends with the final answer, so a judged rule's reminder after it is refused (and logged). Corrective turns and tool refusals work headless.
- **Judged verdicts are yes/no from one call**, not a calibrated probability, and see only the final answer, not what the tools did.
- **A hot reload drops a pending correction** (the timer that would send it is gone). The mod logs that it dropped it.
- **Tool routing is guidance, not containment.** It catches the plain forms above; `bash -c 'cat f'`, `xargs cat`, `sudo cat`, aliases, functions, scripts and any wrapper get through, as does the bypass. Control flow (`if grep -q …; then …`) and expansions skip routing for the whole command. Routing refusals count toward no cap: a model that keeps retrying the shell form is refused each time.
- **Search and file routing are untested against real Grep and Glob tools**, since Claude Code 2.1.310 has neither. Their messages name the tool without an argument example. Count modes (`grep -c`, `rg --count`) are left to Bash.
- **Subagents with fewer tools.** `$.tool.list()` reports the session's tools, not a subagent's: a subagent without `Read` is still pointed to it, and has the bypass.
- Cut from oh-my-pi's bash interceptor: its Write-redirection and managed-service rules, `locate`/`ag`/`ack`, and routing for leading-`cd` commands.
- Cut from the oh-my-pi feature for this version: AST (structural) conditions, the 26 bundled language rules, a global `globs` filter, `contextMode: discard`, per-rule interrupt modes beyond `interrupt: true|false`, and an interactive preview for drafts.

## Install

```sh
claude plugin marketplace add chrisvaillancourt/claude-stream-rules
claude plugin install stream-rules@stream-rules --scope user
```

Or from inside Claude Code: `/plugin install stream-rules --marketplace chrisvaillancourt/claude-stream-rules`.

To work on it locally, add your clone as the marketplace instead (`claude plugin marketplace add <path to clone>`). The plugin is read from that folder; after editing, run `/reload-plugins`.

## Update

```sh
claude plugin marketplace update stream-rules
claude plugin update stream-rules@stream-rules
```

Then restart Claude Code.

0.2.0 adds the opt-in `toolRouting` option (off by default, so nothing changes until you turn it on in `/config`), the `test-tool` subcommand and the `matcher` rule field.

## Develop

```sh
scripts/check.sh
```

It runs `claude plugin validate .`, `claude plugin test .` and a TypeScript check. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).

## License

MIT. See [LICENSE](LICENSE).
