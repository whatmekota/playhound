/**
 * The app's logo, which the owner gets to pick in Settings → Appearance.
 *
 * The files live in public/logos/ rather than going through the bundler, so
 * they have stable URLs: index.html can point the favicon at the chosen one
 * before the app has loaded, and the desktop build can render its icons from
 * them. All of them are the same sly grin drawing in different colourings.
 */

export type LogoId = 'sly-grin' | 'night' | 'noir' | 'crimson' | 'violet' | 'orange' | 'lime'

export interface LogoDef {
  id: LogoId
  label: string
  note: string
}

export const LOGOS: LogoDef[] = [
  { id: 'sly-grin', label: 'Sly grin', note: 'Magenta, orange tongue' },
  { id: 'night', label: 'Night', note: 'Dark face, magenta mouth' },
  { id: 'noir', label: 'Noir', note: 'Black, red and white' },
  { id: 'crimson', label: 'Crimson', note: 'Red, orange tongue' },
  { id: 'violet', label: 'Violet', note: 'Deep purple, pink tongue' },
  { id: 'orange', label: 'Orange', note: 'Orange to rose, pink tongue' },
  { id: 'lime', label: 'Lime', note: 'Acid green, plum mouth' },
]

export const DEFAULT_LOGO: LogoId = 'sly-grin'

export function isLogoId(v: unknown): v is LogoId {
  return typeof v === 'string' && LOGOS.some(l => l.id === v)
}

/** Each colouring also comes with the tongue out (`<id>-tongue.svg`). */
export function logoUrl(id: LogoId, tongue = false): string {
  return `${import.meta.env.BASE_URL}logos/${id}${tongue ? '-tongue' : ''}.svg`
}
