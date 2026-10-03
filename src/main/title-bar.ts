/**
 * The native window-controls overlay drawn over the renderer's own top bar on Windows and Linux.
 * Kept beside each other so the window's creation colours and the Appearance switch agree.
 *
 * `color` mirrors the renderer's `--bg` token for each theme; `symbolColor` is its muted foreground.
 */
export const TITLE_BAR_HEIGHT = 40

export const TITLE_BAR_COLORS = {
  dark: { color: '#0b0b0f', symbolColor: '#a1a1aa' },
  light: { color: '#f4f4f7', symbolColor: '#5c5c6a' }
} as const
