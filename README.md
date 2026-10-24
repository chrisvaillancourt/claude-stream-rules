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
| `enabled` | `true` | `false` turns the rule off, and hides a user rule of the same name. |

What the mod reads of a tool call: `Bash` its `command`; `Edit` its `new_string` (never `old_string`, so deleting a pattern doesn't trip a rule against adding it); `Write` its `content`; `NotebookEdit` its `new_source`; any other tool its input as JSON. Path globs read `file_path`, `notebook_path` or `path`.

Values are single-line. `[a, b]` and `- item` lists both work, and a ` # comment` may follow a value. An unclosed quote, or text after a closing quote or `]`, is a load error rather than a guess. A file that fails to parse is skipped and listed with its error in `/stream-rules list`.

The `examples/` folder has one rule per kind. None is loaded until you copy it into a rules folder:

- `no-rm-rf.md`: refuses `rm -rf` in Bash (tool, stops).
- `ts-no-any.md`: a note after an Edit or Write that adds `any` to a `.ts`/`.tsx` file (tool path glob, reminds, `after-gap`).
- `no-flattery.md`: stops a reply that opens with "you're absolutely right" (text, stops).
- `show-test-output.md`: asks the judge whether a reply claims tests pass without showing output (judged).

## Commands

`/stream-rules [status|list|test <text>|on|off|reload|reset]`

- `status` (the default): on or off and why, how many rules loaded, corrections used, the last error.
- `list`: every rule with its scope, conditions and source, then files that failed to load and why.
- `test <text>`: which rules match the text as a reply. Judged rules show whether their prefilter matched; the question isn't asked.
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

## What it costs

- Matching is local regex work: no model calls, no tokens.
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

## Develop

```sh
scripts/check.sh
```

It runs `claude plugin validate .`, `claude plugin test .` and a TypeScript check. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).

## License

MIT. See [LICENSE](LICENSE).
