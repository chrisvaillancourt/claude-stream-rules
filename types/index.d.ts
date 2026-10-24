export type Mode = 'on' | 'off'

/** Where a rule looks: the reply's text, its streamed thinking, or a tool's input. */
export type Scope = { kind: 'text' } | { kind: 'thinking' } | { kind: 'tool'; tool?: string; glob?: string }

export type Repeat = 'once' | 'always' | 'after-gap'

/** Which folder a rule came from. */
export type RuleSource = 'user' | 'project'

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

/** What the mod keeps for the session. Lives in $.state, so it survives a hot reload. */
export type Session = {
  /** A /stream-rules on|off override for this session; null follows the `enabled` option. */
  mode: Mode | null
  /** Corrective turns submitted since the last prompt that wasn't this mod's. */
  corrections: number
  /** The last error a hook recorded (a guard that failed open, a refused append). */
  lastError: string | null
  /** Per loop (`main` or an agent id): the response count at which each rule last fired. */
  fired: Record<string, Record<string, number>>
  /** Per loop: model responses (turn.step calls) seen. */
  steps: Record<string, number>
  /**
   * Who owns follow-up work. Bumped by every prompt that isn't this mod's,
   * by /stream-rules on|off, and by /clear: a correction or a judgment made
   * under an older epoch is dropped instead of delivered.
   */
  epoch: number
  /** The running (or last) main-loop turn and the epoch it started under. */
  turn: { id: string; epoch: number } | null
}

/** A correction waiting for its turn to end: the turn it stopped, the rules that fired and the prompt to send. */
export type Pending = { id: string; turnId: string; rules: string[]; text: string; epoch: number }

/** A drafted rule waiting for `/stream-rules-draft save`. */
export type Draft = { name: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'stream-rules': {
      session: Shaped<Session>
      pending: Shaped<Pending | null>
      draft: Shaped<Draft | null>
    }
  }
}
