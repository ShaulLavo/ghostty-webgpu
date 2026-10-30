export declare const MIN_CELL: number
export declare const MAX_CELL: number
export declare const SCROLLBAR: number
export declare function sceneGrid(
  width: number,
  ratio: number,
  sceneCols: number,
  sceneRows: number,
  viewport: number,
): {
  readonly cell: number
  readonly columns: number
  readonly rows: number
  readonly height: number
}
export declare function coverScene(
  columns: number,
  rows: number,
  sceneCols: number,
  sceneRows: number,
): {
  readonly columns: number
  readonly rows: number
  readonly dots: Uint8Array
  readonly inks: Uint8Array
  sample(sceneDots: Uint8Array, sceneInks: Uint8Array): void
}
