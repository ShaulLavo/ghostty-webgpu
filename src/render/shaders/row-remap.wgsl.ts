export const rowRemapShader = /* wgsl */ `  var physicalIndex = instanceIndex;
  if (viewport.columns != 0u) {
    physicalIndex = (instanceIndex + viewport.rowOffset * viewport.columns) % viewport.instanceCount;
  }
  let instance = instances[physicalIndex];
  var origin = instance.rect.xy;
  if (viewport.columns != 0u && instance.rect.w != 0.0) {
    origin.y = f32(instanceIndex / viewport.columns) * viewport.rowHeight + origin.y;
  }`
