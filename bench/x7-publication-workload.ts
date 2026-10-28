export const publicationColumns = 200
export const publicationRows = 50
const words = 'alpha beta gamma delta 界 é epsilon zeta eta theta iota kappa lambda mu '

function line(seed: number): string {
  let text = ''
  while (text.length < publicationColumns - 12) text += words.slice(seed % 13) + seed + ' '
  return text.slice(0, publicationColumns - 12)
}

export function publicationOutput(workload: string, step: number, index: number): string {
  if (workload === 'scroll') return `\r\n${line(step * 31 + index)}`
  let out = ''
  for (let y = 0; y < publicationRows; y += 1)
    out += `\x1b[${y + 1};1H\x1b[2K${line(step * 7 + y + index)}`
  return out
}
