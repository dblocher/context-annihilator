import { REASON_CODES, RELEVANCE_LABELS } from '../../contracts/decisions.js'

/** Frames every decision call. Biases toward keeping context, because false drops cost more. */
export const DECISION_SYSTEM_PROMPT =
  'You classify records from a previous coding-agent session for a context-reduction tool. ' +
  'A fresh session will receive only the records that are kept, so dropping a record the task needs ' +
  'is much worse than keeping one it does not need. When two labels both fit, choose the label that ' +
  "keeps more context. Choose 'uncertain' when the task summary does not give enough information to judge the record."

export const RELEVANCE_QUESTION = {
  question:
    "Which label best describes this record's value for completing the current task in the task summary? " +
    'required: directly necessary, authoritative (a constraint, decision, or requirement), or contains an ' +
    'unresolved dependency or error the task still depends on. ' +
    'supporting: likely useful evidence or continuity, but not strictly necessary. ' +
    'irrelevant: unrelated to the current task, superseded by later work, or redundant.',
  choices: RELEVANCE_LABELS,
} as const

export const REASON_QUESTION = {
  question:
    'Which reason best explains the label you chose? ' +
    'direct-dependency: the task directly needs this content. ' +
    'authoritative-constraint: states a requirement, constraint, or decision the task must follow. ' +
    'unresolved-issue: contains an error, failure, or open question not yet resolved. ' +
    'useful-evidence: helpful background or evidence for the task. ' +
    'continuity: keeps the history of the work coherent. ' +
    'unrelated: about a different task or topic. ' +
    'superseded: replaced by later plans, fixes, or file versions. ' +
    'duplicate: repeats content that appears later in the session.',
  choices: REASON_CODES,
} as const
