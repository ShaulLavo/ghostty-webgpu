const studyRequestDevice = GPUAdapter.prototype.requestDevice
GPUAdapter.prototype.requestDevice = async function (descriptor) {
  const device = await studyRequestDevice.call(this, descriptor)
  const info = device.adapterInfo
  console.info(
    'STUDY_WEBGPU_ADAPTER ' +
      JSON.stringify({
        vendor: info.vendor,
        architecture: info.architecture,
        description: info.description,
        fallback: info.isFallbackAdapter,
      }),
  )
  return device
}
