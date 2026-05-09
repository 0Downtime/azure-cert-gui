---
version: alpha
name: Azure Portal
description: "An operator-first Azure Portal inspired system: compact blade surfaces, Segoe UI typography, Azure blue command and selection states, neutral gray canvas layers, low-radius controls, and quiet semantic strips. The app should feel familiar beside Azure Portal without copying its information architecture. Use dense tables, thin dividers, command-bar controls, and restrained status color. Dark and light themes are both first-class."

colors:
  primary: "#0078d4"
  primary-hover: "#106ebe"
  primary-active: "#005a9e"
  primary-focus: "#2899f5"
  on-primary: "#ffffff"
  ink: "#201f1e"
  ink-muted: "#605e5c"
  ink-subtle: "#8a8886"
  canvas: "#f8f9fa"
  surface-1: "#ffffff"
  surface-2: "#f3f2f1"
  surface-3: "#edebe9"
  chrome: "#ffffff"
  chrome-ink: "#201f1e"
  hairline: "#d2d0ce"
  hairline-strong: "#8a8886"
  selected: "#e5f1fb"
  info-bg: "#eff6fc"
  success: "#107c10"
  success-bg: "#f1faf1"
  warning: "#8a6a00"
  warning-bg: "#fff8dc"
  danger: "#a4262c"
  danger-bg: "#fde7e9"
  inverse-canvas: "#1b1a19"
  inverse-surface-1: "#201f1e"
  inverse-surface-2: "#2b2a29"
  inverse-surface-3: "#323130"
  inverse-ink: "#f3f2f1"
  inverse-ink-muted: "#c8c6c4"
  inverse-ink-subtle: "#a19f9d"
  inverse-hairline: "#3b3a39"
  inverse-hairline-strong: "#605e5c"
  inverse-selected: "#062a4f"
  inverse-info-bg: "#002b5c"
  inverse-success: "#6bb700"
  inverse-success-bg: "#163b16"
  inverse-warning: "#fce100"
  inverse-warning-bg: "#4a3b00"
  inverse-danger: "#f1707b"
  inverse-danger-bg: "#4a2024"

typography:
  fontFamily: "Segoe UI, SegoeUI, Helvetica Neue, Arial, sans-serif"
  title:
    fontSize: 22px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: 0
  blade-title:
    fontSize: 26px
    fontWeight: 600
    lineHeight: 1.23
    letterSpacing: 0
  section:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.33
    letterSpacing: 0
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    letterSpacing: 0
  body-strong:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.43
    letterSpacing: 0
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.33
    letterSpacing: 0
  command:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.33
    letterSpacing: 0
  metric:
    fontSize: 28px
    fontWeight: 400
    lineHeight: 1.15
    letterSpacing: 0

rounded:
  none: 0px
  xs: 2px
  sm: 4px
  md: 6px
  lg: 8px

spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px

components:
  shell:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
  blade:
    backgroundColor: "{colors.surface-1}"
    borderColor: "{colors.hairline}"
    rounded: "{rounded.none}"
  topbar:
    backgroundColor: "{colors.chrome}"
    textColor: "{colors.chrome-ink}"
    borderColor: "{colors.hairline}"
    height: 56px
  command-button:
    backgroundColor: transparent
    textColor: "{colors.ink}"
    borderColor: transparent
    typography: "{typography.command}"
    rounded: "{rounded.xs}"
    padding: 6px 10px
  command-button-hover:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
  primary-button:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    borderColor: "{colors.primary}"
    typography: "{typography.command}"
    rounded: "{rounded.xs}"
    padding: 7px 14px
  primary-button-hover:
    backgroundColor: "{colors.primary-hover}"
    borderColor: "{colors.primary-hover}"
  input:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline-strong}"
    typography: "{typography.body}"
    rounded: "{rounded.xs}"
    padding: 7px 10px
  input-focused:
    borderColor: "{colors.primary}"
    focusRing: "{colors.primary-focus}"
  tab:
    backgroundColor: transparent
    textColor: "{colors.ink-muted}"
    activeBorderColor: "{colors.primary}"
    activeTextColor: "{colors.ink}"
  table:
    headerBackground: "{colors.surface-2}"
    rowBackground: "{colors.surface-1}"
    rowHoverBackground: "{colors.surface-2}"
    selectedBackground: "{colors.selected}"
    borderColor: "{colors.hairline}"
  chip:
    rounded: "{rounded.xs}"
    fontSize: 12px
    fontWeight: 600
    padding: 3px 8px
  info-strip:
    backgroundColor: "{colors.info-bg}"
    borderColor: "{colors.primary}"
    textColor: "{colors.ink}"
  warning-strip:
    backgroundColor: "{colors.warning-bg}"
    borderColor: "{colors.warning}"
    textColor: "{colors.ink}"
  error-strip:
    backgroundColor: "{colors.danger-bg}"
    borderColor: "{colors.danger}"
    textColor: "{colors.ink}"

implementation_notes:
  - Preserve the existing dashboard layout, routes, data model, and workflow behavior.
  - Prefer density and scanability over marketing-scale presentation.
  - Use Azure blue for selection, focus, links, command emphasis, and primary actions.
  - Use semantic colors mostly in chips, thin borders, and alert strips rather than large saturated panels.
  - Keep corners low-radius and surfaces flat; use shadows only for floating menus and modals.
  - Match both themes deliberately. Dark mode should use Azure Portal-like dark blade surfaces, and light mode should use equivalent neutral blade surfaces.
---
