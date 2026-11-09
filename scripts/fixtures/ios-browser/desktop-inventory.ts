export function collectDesktopInventory(input: {
  mode: string
  normal: string[]
  events: { event: string; role: string }[]
}): void {
  input.normal.push('ordinary-collected')
  if (input.mode !== 'inventory-reject') return
  input.events.push({ event: 'collected', role: 'node' })
  throw new Error('LOCAL_INVENTORY_REJECT')
}
