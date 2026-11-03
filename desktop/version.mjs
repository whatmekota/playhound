// Version comparison for the updater, apart so it can be tested without Electron.

/** 1.10.0 > 1.9.2, and a pre-release sorts below its release. */
export function newer(a, b) {
  const parse = v => String(v).replace(/^v/, '').split('-')
  const [ma, pa] = parse(a)
  const [mb, pb] = parse(b)
  const xa = ma.split('.').map(Number)
  const xb = mb.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((xa[i] || 0) !== (xb[i] || 0))
      return (xa[i] || 0) > (xb[i] || 0)
  }
  return !pa && !!pb
}
