import type { GlobalThemeOverrides } from 'naive-ui'

/**
 * naive-ui theme overrides built from the CSS tokens in `assets/tokens.css`.
 *
 * Read from the live stylesheet rather than duplicated here, so `tokens.css` stays the one place a
 * colour is defined. naive-ui can't take `var(--x)` itself — it derives hover and pressed shades by
 * parsing the colour — so each token is resolved to a concrete `rgb()`/`rgba()` string first.
 *
 * Call it after `<html data-theme>` reflects the current theme (the theme store keeps that in sync),
 * so the right set of values is read.
 */
export function naiveOverrides(): GlobalThemeOverrides {
  const style = getComputedStyle(document.documentElement)
  const triple = (name: string): string => style.getPropertyValue(name).trim().replace(/\s+/g, ', ')
  const rgb = (name: string): string => `rgb(${triple(name)})`
  const rgba = (name: string, alpha: number): string => `rgba(${triple(name)}, ${alpha})`

  const accent = rgb('--accent')
  const line = (alpha: number): string => rgba('--line', alpha)

  return {
    common: {
      fontFamily: style.getPropertyValue('--font-sans').trim(),
      fontFamilyMono: style.getPropertyValue('--font-mono').trim(),
      borderRadius: '6px',
      borderRadiusSmall: '4px',

      primaryColor: accent,
      primaryColorHover: rgba('--accent', 0.85),
      primaryColorPressed: rgba('--accent', 0.75),
      primaryColorSuppl: rgba('--accent', 0.85),
      infoColor: rgb('--c-transactional'),
      infoColorHover: rgba('--c-transactional', 0.85),
      infoColorPressed: rgba('--c-transactional', 0.75),
      infoColorSuppl: rgba('--c-transactional', 0.85),
      successColor: rgb('--ok'),
      successColorHover: rgba('--ok', 0.85),
      successColorPressed: rgba('--ok', 0.75),
      successColorSuppl: rgba('--ok', 0.85),
      warningColor: rgb('--warn'),
      warningColorHover: rgba('--warn', 0.85),
      warningColorPressed: rgba('--warn', 0.75),
      warningColorSuppl: rgba('--warn', 0.85),
      errorColor: rgb('--danger'),
      errorColorHover: rgba('--danger', 0.85),
      errorColorPressed: rgba('--danger', 0.75),
      errorColorSuppl: rgba('--danger', 0.85),

      bodyColor: rgb('--bg'),
      cardColor: rgb('--surface-1'),
      modalColor: rgb('--surface-1'),
      popoverColor: rgb('--surface-3'),
      tableColor: rgb('--surface-1'),
      inputColor: rgb('--surface-2'),
      actionColor: rgb('--surface-2'),
      tagColor: rgb('--surface-3'),

      textColorBase: rgb('--fg'),
      textColor1: rgb('--fg'),
      textColor2: rgb('--fg'),
      textColor3: rgb('--fg-muted'),
      placeholderColor: rgb('--fg-subtle'),

      borderColor: line(0.08),
      dividerColor: line(0.06),
      hoverColor: line(0.04),
      pressedColor: line(0.07)
    },
    // Dense desktop UI: small controls read at the same size as the surrounding 13px text.
    Button: {
      fontSizeSmall: '13px',
      fontSizeTiny: '12px'
    },
    // A switch that is "on" means "this link is followed", not a primary action — keep purple for those.
    Switch: {
      railColorActive: rgb('--ok')
    }
  }
}
