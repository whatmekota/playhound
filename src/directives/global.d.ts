// Global directives registered in src/main.ts
export {}

declare module 'vue' {
  interface GlobalDirectives {
    vTip: typeof import('./tip')['vTip']
  }
}
