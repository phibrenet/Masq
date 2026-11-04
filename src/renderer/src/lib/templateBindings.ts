import type { FakeGenerator, TemplateBinding } from '@shared/types'

/**
 * The template builder shows one dropdown per JSON path. Its value is a generator name, or one of
 * the sentinels below for the outcomes that aren't a generator. These two functions translate
 * between that dropdown value and a stored `TemplateBinding`.
 *
 * The sentinels must never reach storage as a `generator`. The engine treats an unknown generator
 * as nothing to do, so a path the user set to "Redact" would keep its real value in the dump.
 */

/** "Leave as-is" is the absence of a binding, not a stored value. */
export const LEAVE_AS_IS = ''
export const REDACT = '__redact__'
export const REMOVE = '__remove__'

/** The dropdown value that shows a saved binding. */
export function bindingChoice(binding: TemplateBinding): string {
  if (binding.action === 'redact') return REDACT
  if (binding.action === 'remove') return REMOVE
  return binding.generator ?? LEAVE_AS_IS
}

/** The binding a dropdown value stands for, or `null` when the path is left as-is. */
export function bindingFromChoice(
  path: string,
  choice: string | undefined
): TemplateBinding | null {
  const trimmed = path.trim()
  if (!trimmed || !choice || choice === LEAVE_AS_IS) return null
  if (choice === REDACT) return { path: trimmed, action: 'redact' }
  if (choice === REMOVE) return { path: trimmed, action: 'remove' }
  return { path: trimmed, generator: choice as FakeGenerator }
}
