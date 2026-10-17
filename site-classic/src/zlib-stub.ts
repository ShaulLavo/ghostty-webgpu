function unavailable(): never {
  throw new TypeError('gzip is unavailable in the browser shell')
}

export const constants = {}
export const gzipSync = unavailable
export const gunzipSync = unavailable
