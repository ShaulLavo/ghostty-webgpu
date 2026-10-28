declare module 'bidi-js' {
  interface EmbeddingLevels {
    levels: Uint8Array
    paragraphs: { start: number; end: number; level: number }[]
  }
  export default function bidiFactory(): {
    getEmbeddingLevels(text: string, direction: 'ltr'): EmbeddingLevels
    getReorderedIndices(text: string, levels: EmbeddingLevels): number[]
    getMirroredCharactersMap(text: string, levels: Uint8Array): Map<number, string>
  }
}
