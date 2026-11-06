import type { ReadRowsOptions, RenderRow } from './types.js'

export const retainDisplayedFrame = Symbol('retainDisplayedFrame')
export const captureRenderAcknowledgement = Symbol('captureRenderAcknowledgement')
export const observeDisplayedFrame = Symbol('observeDisplayedFrame')
export const attachCanvasImage = Symbol('attachCanvasImage')

export const captureDisplayedRows = Symbol('captureDisplayedRows')
export const displayedRows = Symbol('displayedRows')
export const captureSubmission = Symbol('captureSubmission')
export const capturedSubmission = Symbol('capturedSubmission')

/** Frame rows are readable only while their captured native snapshot version is current. */
export interface DisplayedRows {
  readRows(options?: Pick<ReadRowsOptions, 'rows' | 'packed'>): readonly RenderRow[]
}
