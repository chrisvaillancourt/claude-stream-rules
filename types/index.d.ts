export type Mode = 'on' | 'off'

/** Where a rule looks: the reply's text, its streamed thinking, or a tool's input. */
export type Scope = { kind: 'text' } | { kind: 'thinking' } | { kind: 'tool'; tool?: string; glob?: string }

export type Repeat = 'once' | 'always' | 'after-gap'

/** Where a rule came from: the mod's bundled ruleset, your folder, or the project's. Later wins by name. */
export type RuleSource = 'bundled' | 'user' | 'project'

/** A routing rule's structural Bash matcher (hooks/bash.ts), one per native-tool family. */
export type Matcher = 'bash-native-read' | 'bash-native-edit' | 'bash-native-search' | 'bash-native-files'

/** A rule file, parsed and validated. Plain data: the compiled regexes are made from `conditions`. */
export type RuleSpec = {
  name: string
  description: string
  /** Regex sources as written (a leading `(?i)` and the like included). */
  conditions: string[]
  scope: Scope[]
  interrupt: boolean
  /** null: the default for where it matched (`once` for prose, `always` for tools). */
  repeat: Repeat | null
  gap: number
  /** A judged rule's yes/no question; yes means the rule was broken. */
  question?: string
  /** A routing rule's matcher. Such a rule has no conditions or question and only the tool:Bash scope. */
  matcher?: Matcher
  enabled: boolean
  /** The message the model is given. */
  body: string
  source: RuleSource
  path: string
}

/** A rule file that didn't load, and why. */
export type LoadError = { path: string; error: string }

export type JudgeAction = 'remind' | 'correct'

/** The options in plugin.json's userConfig, parsed with defaults filled in. */
export type Config = {
  enabled: boolean
  maxCorrections: number
  judgeModel: string
  judgeMaxPerTurn: number
  judgeAction: JudgeAction
  draftModel: string
}

/** A rule firing that was claimed: per rule, the value it replaced, so an undelivered claim can be released. */
export type Claim = { loop: string; at: number; prior: Record<string, number | null> }

/**
 * A correction waiting for its turn to end. `aborting` until `$.turn.abort`
 * answers, then `aborted`; the corrective prompt is sent after the turn's
 * `turn.complete`, only while `epoch` is still the session's.
 */
export type Pending = { id: string; turnId: string; epoch: number; rules: string[]; text: string; reminder: string; claim: Claim; phase: 'aborting' | 'aborted' }

/** What the mod keeps for the session. Lives in $.state, so it survives a hot reload. */
export type Session = {
  /** A /stream-rules on|off override for this session; null follows the `enabled` option. */
  mode: Mode | null
  /** Corrective turns submitted since the last superseding prompt. */
  corrections: number
  /** The last error a hook recorded (a guard that failed open, a refused append). */
  lastError: string | null
  /** Per loop (`main` or an agent id): the response count at which each rule last fired. */
  fired: Record<string, Record<string, number>>
  /** Per loop: model responses (turn.step calls) seen. */
  steps: Record<string, number>
  /**
   * Who owns follow-up work. A superseding prompt, /stream-rules on|off and
   * /clear start a new epoch; work owned by an older one is dropped.
   */
  epoch: number
  /** The running (or last) main-loop turn and the epoch it started under. */
  turn: { id: string; epoch: number } | null
  /** The correction in flight, if any. */
  pending: Pending | null
}

/** A drafted rule waiting for `/stream-rules-draft save`. */
export type Draft = { name: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'stream-rules': {
      session: Shaped<Session>
      draft: Shaped<Draft | null>
    }
  }
}
