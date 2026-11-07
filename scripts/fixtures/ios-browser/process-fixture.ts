const mode = process.argv[2]
if (mode === 'partial') process.exitCode = 4
else if (mode === 'hang') setInterval(() => {}, 1000)
else if (mode === 'ignore-term') {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
} else throw new Error('Unknown local process fixture')
