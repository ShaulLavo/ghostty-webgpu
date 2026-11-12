declare module 'pngjs/browser.js' {
  export class PNG {
    width: number
    height: number
    data: Uint8Array
    parse(bytes: Uint8Array, callback: (error: Error | null, image: PNG | null) => void): this
  }
}
