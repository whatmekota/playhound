declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<object, object, any>
  export default component
}

// osr-emu ships no type declarations
declare module 'osr-emu' {
  export class OSREmulator {
    constructor(target: HTMLElement | string)
    write: (command: string) => void
    dispose?: () => void
  }
}
