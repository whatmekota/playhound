export interface MenuItem {
  label?: string
  icon?: string
  kbd?: string
  run?: () => void
  disabled?: boolean
  danger?: boolean
  /** Shows a check on the right, for toggles inside a menu. */
  checked?: boolean
  /** Render a divider instead of an item. */
  separator?: boolean
  /** Render a small section heading instead of an item. */
  heading?: boolean
}
