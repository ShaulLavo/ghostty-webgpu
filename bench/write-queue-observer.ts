export function observeGpuSubmissions(onSubmit: () => void): () => void {
  const submit = GPUQueue.prototype.submit
  GPUQueue.prototype.submit = function (commands) {
    submit.call(this, commands)
    onSubmit()
  }
  return () => {
    GPUQueue.prototype.submit = submit
  }
}
