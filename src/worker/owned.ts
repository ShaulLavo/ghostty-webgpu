/** Structured cloning drops frozen descriptors; restore readonly values at the receiving boundary. */
export function freezeWorkerValue<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value
  if (Object.isFrozen(value)) return value
  for (const child of Object.values(value)) freezeWorkerValue(child)
  return Object.freeze(value)
}
