// Node 25+ has a localStorage and sessionStorage of its own (Web Storage,
// file-backed, and without --localstorage-file an object with no methods).
// They are already on the global when jsdom's window is copied over, so the
// tests saw Node's instead of jsdom's. Put jsdom's back.
const dom = (globalThis as { jsdom?: { window: Window } }).jsdom
if (dom) {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    Object.defineProperty(globalThis, name, {
      value: dom.window[name],
      configurable: true,
      writable: true,
    })
  }
}
