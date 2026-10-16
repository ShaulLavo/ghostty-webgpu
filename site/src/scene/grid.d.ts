export declare const MIN_CELL: number
export declare const SCROLLBAR: number
export declare function sceneGrid(
  width: number,
  ratio: number,
  sceneCols: number,
  sceneRows: number,
): {
  readonly cell: number
  readonly columns: number
  readonly rows: number
  readonly height: number
}
export declare function coverMap(
  columns: number,
  rows: number,
  sceneCols: number,
  sceneRows: number,
): { readonly mapX: Int32Array; readonly mapY: Int32Array }
