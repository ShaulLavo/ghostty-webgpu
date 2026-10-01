const README = `# ghostty-webgpu

An unofficial Ghostty for the web: libghostty-vt in WebAssembly,
drawn by a damage-aware WebGPU renderer.

This shell is just-bash, a bash interpreter written in TypeScript.
Its files live in memory and vanish when you close the tab.

  ls -la              what is here
  cat colors.sh       a script; run it with: bash colors.sh
  grep warn logs/*    search the logs
  seq 1 50000         a lot of output, fast
  bench 20            stream 20 MB into the terminal and time it
`

const COLORS = `#!/bin/bash
# 24-bit color ramps, one cell per step.
for row in 0 1 2; do
  line=""
  for i in $(seq 0 63); do
    v=$(( i * 4 ))
    case $row in
      0) line="$line\\033[48;2;$v;$(( 255 - v ));180m " ;;
      1) line="$line\\033[48;2;126;$v;$(( 255 - v ))m " ;;
      2) line="$line\\033[48;2;$v;$v;\${v}m " ;;
    esac
  done
  printf "$line\\033[0m\\n"
done
printf "\\033[1mbold\\033[0m \\033[3mitalic\\033[0m \\033[4munderline\\033[0m \\033[9mstrike\\033[0m \\033[7minverse\\033[0m\\n"
printf "wide: 你好 こんにちは 안녕하세요  emoji: 👻 🚀 🧪\\n"
`

function buildLog(): string {
  const steps = ['resolve', 'compile', 'link', 'bundle', 'test', 'publish']
  const lines: string[] = []
  for (let i = 0; i < 120; i += 1) {
    const step = steps[i % steps.length]!
    const level = i % 17 === 0 ? 'warn' : 'info'
    lines.push(`2026-10-01T12:${String(i % 60).padStart(2, '0')}:00Z ${level} ${step} unit ${i}`)
  }
  return `${lines.join('\n')}\n`
}

export function shellFiles(home: string): Record<string, string> {
  return {
    [`${home}/README.md`]: README,
    [`${home}/colors.sh`]: COLORS,
    [`${home}/logs/build.log`]: buildLog(),
  }
}
