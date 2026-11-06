declare module 'pngjs' {
  export const PNG: { sync: { read(bytes: Uint8Array): unknown } }
}
