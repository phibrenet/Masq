import type { FormRules } from 'naive-ui'
import type {
  ExceptionRule,
  FakeGenerator,
  FieldStrategyKind,
  FieldStrategyRule,
  ObfuscateSide
} from '@shared/types'
import { OBFUSCATE_MIN_COUNT } from '@shared/types'

/**
 * A strategy rule mid-edit, flat so each input binds to its own field and switching kind doesn't
 * lose what the other kinds held. Shared by a strategy's main rule and its exception. `template`
 * isn't built from this: its bindings have their own builder.
 */
export interface RuleDraft {
  kind: FieldStrategyKind
  generator: FakeGenerator
  percent: number | null
  obfuscateSide: ObfuscateSide
  obfuscateCount: number | null
  obfuscateDelimiter: string
}

export function blankRuleDraft(kind: FieldStrategyKind = 'fake'): RuleDraft {
  return {
    kind,
    generator: 'fullName',
    percent: 10,
    obfuscateSide: 'last',
    obfuscateCount: OBFUSCATE_MIN_COUNT,
    obfuscateDelimiter: '@'
  }
}

export function ruleDraftFrom(rule: FieldStrategyRule): RuleDraft {
  const draft = blankRuleDraft(rule.kind)
  if (rule.kind === 'fake') draft.generator = rule.generator
  if (rule.kind === 'jitter') draft.percent = rule.percent
  if (rule.kind === 'obfuscate') {
    draft.obfuscateSide = rule.side
    if (rule.side === 'before') draft.obfuscateDelimiter = rule.delimiter
    else draft.obfuscateCount = rule.count
  }
  return draft
}

/** The rule a non-template draft stands for. */
export function ruleFromDraft(draft: RuleDraft): ExceptionRule {
  switch (draft.kind) {
    case 'preserve':
      return { kind: 'preserve' }
    case 'redact':
      return { kind: 'redact' }
    case 'fake':
      return { kind: 'fake', generator: draft.generator }
    case 'jitter':
      return { kind: 'jitter', percent: draft.percent ?? 0 }
    case 'obfuscate':
      return draft.obfuscateSide === 'before'
        ? { kind: 'obfuscate', side: 'before', delimiter: draft.obfuscateDelimiter }
        : {
            kind: 'obfuscate',
            side: draft.obfuscateSide,
            count: draft.obfuscateCount ?? OBFUSCATE_MIN_COUNT
          }
    case 'template':
      // Never silently widen a template into some other kind: the caller builds templates itself.
      throw new Error('A template rule is built from its bindings, not from a rule draft.')
  }
}

/**
 * Form validation for the fields this draft's kind shows. Keys are added only when they apply: an
 * empty rule descriptor isn't "no rule" to async-validator, it defaults to `type: 'string'` and then
 * fails on a number field (see the selection-rule form).
 */
export function ruleDraftRules(draft: RuleDraft): FormRules {
  const rules: FormRules = {}
  if (draft.kind === 'jitter')
    rules.percent = {
      validator: () => ((draft.percent ?? 0) > 0 ? true : new Error('Enter a positive percentage')),
      trigger: ['blur', 'change']
    }
  if (draft.kind === 'obfuscate' && draft.obfuscateSide !== 'before')
    rules.obfuscateCount = {
      validator: () =>
        (draft.obfuscateCount ?? 0) >= OBFUSCATE_MIN_COUNT
          ? true
          : new Error(
              `Scramble at least ${OBFUSCATE_MIN_COUNT} characters — fewer leaves the value ` +
                `re-identifiable by anyone holding the originals.`
            ),
      trigger: ['blur', 'change']
    }
  if (draft.kind === 'obfuscate' && draft.obfuscateSide === 'before')
    rules.obfuscateDelimiter = {
      // Not trimmed: a space is a legitimate delimiter.
      validator: () =>
        draft.obfuscateDelimiter.length > 0 ? true : new Error('Enter the character to stop at'),
      trigger: ['blur', 'input']
    }
  return rules
}
