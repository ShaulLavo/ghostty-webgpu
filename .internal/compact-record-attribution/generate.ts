import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [repo, destination] = process.argv.slice(2)
assert(repo && destination)
const original = await readFile(join(repo, 'scripts/bridge.zig'), 'utf8')
function replace(source: string, old: string, next: string): string {
  assert.equal(source.split(old).length, 2, `Expected one anchor: ${old.slice(0, 90)}`)
  return source.replace(old, next)
}
function between(source: string, first: string, last: string): string {
  const start = source.indexOf(first)
  const end = source.indexOf(last, start)
  assert(start >= 0 && end > start)
  return source.slice(start, end)
}
const cellBody = between(
  original,
  '    const cell = &frame.cell_data[index];\n    const glyph',
  '    if (content.continuation',
)
const glyphBody = between(
  original,
  '    glyph[0..4].* =',
  '    return c.GHOSTTY_SUCCESS;\n}\n\nfn buildCell',
)
const cellArgs = 'stable, bidi, projection, frame, index, x, y, style, fg, bg, selected'
const glyphArgs = 'frame, index, y, style, foreground, background, left, top, entry'
const helpers = `
const ProbeStyle = struct { foreground: u32, background: u32, left: f32, top: f32 };
noinline fn probeConstructCell(comptime stable: bool, comptime bidi: bool, projection: ?[*]const BidiCell, frame: *Frame, index: u32, x: u32, y: u32, style: c.GhosttyStyle, fg: u32, bg: u32, selected: bool) ProbeStyle {
${cellBody}    return .{ .foreground = foreground, .background = background, .left = left, .top = top };
}
noinline fn probeConstructGlyph(frame: *Frame, index: u32, y: u32, style: c.GhosttyStyle, foreground: u32, background: u32, left: f32, top: f32, entry: glyph_index.Glyph) void {
    const glyph = &frame.glyph_data[index];
${glyphBody}}
`
const context = `    const foreground = prepared.foreground;
    const background = prepared.background;
    const left = prepared.left;
    const top = prepared.top;
`
let extracted = replace(
  original,
  cellBody,
  `    const prepared = probeConstructCell(${cellArgs});\n${context}`,
)
extracted = replace(extracted, glyphBody, `    probeConstructGlyph(${glyphArgs});\n`)
extracted += helpers
const metrics = `
extern "env" fn probe_now() f64;
var probe_totals: [6]f64 = @splat(0);
var probe_counts: [6]u32 = @splat(0);
var probe_repetitions: u32 = 1;
export fn bridge_probe_reset(repetitions: u32) void {
    probe_totals = @splat(0);
    probe_counts = @splat(0);
    probe_repetitions = repetitions;
}
export fn bridge_probe_get(index: u32) f64 { return probe_totals[index]; }
export fn bridge_probe_count(index: u32) u32 { return probe_counts[index]; }
fn probeStart() f64 {
    const empty = probe_now();
    probe_totals[5] += probe_now() - empty;
    probe_counts[5] += 1;
    return probe_now();
}
fn probeEnd(index: u32, started: f64) void {
    probe_totals[index] += probe_now() - started;
    probe_counts[index] += 1;
}
`
let timed = replace(
  extracted,
  `    const prepared = probeConstructCell(${cellArgs});`,
  `    const cell_started = probeStart();
    var prepared = probeConstructCell(${cellArgs});
    var repeat_cell: u32 = 1;
    while (repeat_cell < probe_repetitions) : (repeat_cell += 1) prepared = probeConstructCell(${cellArgs});
    probeEnd(0, cell_started);`,
)
timed = replace(
  timed,
  `    probeConstructGlyph(${glyphArgs});`,
  `    const glyph_started = probeStart();
    var repeat_glyph: u32 = 0;
    while (repeat_glyph < probe_repetitions) : (repeat_glyph += 1) probeConstructGlyph(${glyphArgs});
    probeEnd(1, glyph_started);`,
)
const snapshots =
  '        const previous_cell = frame.cell_data[slot];\n        const previous_glyph = frame.glyph_data[slot];'
timed = replace(
  timed,
  snapshots,
  `        const snapshot_started = probeStart();\n${snapshots}\n        probeEnd(2, snapshot_started);`,
)
const comparison = between(
  timed,
  '        if (force or !std.mem.eql(u8, std.mem.asBytes(&previous_cell)',
  '    }\n    // Logical row changes',
)
timed = replace(
  timed,
  comparison,
  `        const compare_started = probeStart();\n${comparison}        probeEnd(3, compare_started);\n`,
)
timed = replace(
  timed,
  '    const key = glyph_index.resolve(frame.glyph_index, .{',
  '    const lookup_started = probeStart();\n    const key = glyph_index.resolve(frame.glyph_index, .{',
)
timed = replace(
  timed,
  '    frame.row_cache.?.next[y].cells[x].key = key;',
  '    probeEnd(4, lookup_started);\n    frame.row_cache.?.next[y].cells[x].key = key;',
)
await writeFile(join(destination, 'extracted.zig'), extracted)
await writeFile(join(destination, 'timed.zig'), timed + metrics)
console.log('Generated isolated record, snapshot, comparison and lookup probes. No layout change.')
