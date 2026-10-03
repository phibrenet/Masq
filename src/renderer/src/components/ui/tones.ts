/**
 * Every colour a badge, dot, chip or segment can take, mapped to its token. Kept as one static table
 * so components pick a tone by name and the token stays the only definition of the colour.
 *
 * Components apply a tone by setting `--tone` to the token (`style="--tone: var(--ok)"`) and styling
 * with `rgb(var(--tone) / <alpha>)`.
 */
export const TONES = {
  accent: 'var(--accent)',
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
  muted: 'var(--fg-muted)',
  subtle: 'var(--fg-subtle)',
  'cls-transactional': 'var(--c-transactional)',
  'cls-reference': 'var(--c-reference)',
  'cls-structure': 'var(--c-structure)',
  'cls-excluded': 'var(--c-excluded)',
  'strat-preserve': 'var(--s-preserve)',
  'strat-redact': 'var(--s-redact)',
  'strat-fake': 'var(--s-fake)',
  'strat-obfuscate': 'var(--s-obfuscate)',
  'strat-jitter': 'var(--s-jitter)',
  'strat-template': 'var(--s-template)'
} as const

export type Tone = keyof typeof TONES

export function toneStyle(tone: Tone): Record<string, string> {
  return { '--tone': TONES[tone] }
}
