// Fleet page for the shared-surface experiment: N production-default WebGPU renderers, each with
// its own canvas element, drawing either to their own canvases or to one shared surface.
import { GhosttyRuntime } from "../../src/core/runtime.js";
import { fitTerminalFont } from "../../src/dom/fit.js";
import { WebGpuTerminalRenderer } from "../../src/render/webgpu/renderer.js";
import { WebGpuSharedSurface } from "../../src/render/webgpu/shared-surface.js";

const parameters = new URL(location.href).searchParams;
const count = Number(parameters.get("count") ?? 16);
const columns = Number(parameters.get("columns") ?? 80);
const rows = Number(parameters.get("rows") ?? 24);
const shared = parameters.get("shared") === "1";
const mount = document.querySelector("main")!;
const nativeRequestFrame = window.requestAnimationFrame.bind(window);
let frameCallbacks: number[] = [];
window.requestAnimationFrame = (callback) =>
  nativeRequestFrame((time) => {
    const started = performance.now();
    callback(time);
    frameCallbacks.push(performance.now() - started);
  });

const font = fitTerminalFont(
  document,
  {
    boldWeight: 700,
    family: "monospace",
    letterSpacing: 0,
    lineHeight: 1.2,
    size: 13,
    weight: 400,
  },
  devicePixelRatio,
);
mount.style.gridTemplateColumns = `repeat(${Math.ceil(Math.sqrt(count))}, max-content)`;
const surface = shared ? new WebGpuSharedSurface(mount) : undefined;

interface Pane {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: WebGpuTerminalRenderer;
  readonly runtime: GhosttyRuntime;
  readonly terminal: ReturnType<GhosttyRuntime["createTerminal"]>;
  readonly state: ReturnType<GhosttyRuntime["createRenderState"]>;
  acknowledgements: number;
  writes: number[];
}

const errors: string[] = [];
const latency = { acknowledged: [] as number[], nextFrame: [] as number[] };
let sequence = 0;

async function createPane(index: number): Promise<Pane> {
  const host = document.createElement("div");
  host.className = "pane";
  const canvas = document.createElement("canvas");
  host.append(canvas);
  mount.append(host);
  const runtime = await GhosttyRuntime.create({
    wasm: "/ghostty-vt.wasm",
    bridge: "/bridge.wasm",
  });
  const terminal = runtime.createTerminal({
    columns,
    rows,
    cellWidth: font.deviceCellWidth,
    cellHeight: font.deviceCellHeight,
  });
  const state = runtime.createRenderState(terminal);
  const pane = {
    canvas,
    runtime,
    terminal,
    state,
    acknowledgements: 0,
    writes: [],
  } as unknown as Pane;
  const renderState = {
    get snapshotVersion() {
      return state.snapshotVersion;
    },
    createFrameBuilder: (c: number, r: number) =>
      state.createFrameBuilder(c, r),
    update: () => state.update(),
    readCursor: () => state.readCursor(),
    readRows: (options?: Parameters<typeof state.readRows>[0]) =>
      state.readRows(options),
    acknowledge: () => {
      const rowsAcknowledged = state.acknowledge();
      pane.acknowledgements += 1;
      if (index === 0) recordAcknowledgement(pane);
      return rowsAcknowledged;
    },
  };
  const renderer = await WebGpuTerminalRenderer.create({
    canvas,
    columns,
    rows,
    font,
    renderState,
    surface,
    needsFrameRows: () => false,
    onError: (cause) =>
      errors.push(cause instanceof Error ? cause.message : String(cause)),
    theme: {
      foreground: { r: 230, g: 230, b: 230 },
      background: { r: 16, g: 16, b: 24 },
    },
  });
  renderer.setCursorBlinkEnabled(false);
  renderer.setFocused(false);
  Object.assign(pane, { renderer });
  return pane;
}

function recordAcknowledgement(pane: Pane): void {
  const now = performance.now();
  const pending = pane.writes.splice(0);
  for (const written of pending) latency.acknowledged.push(now - written);
  if (pending.length === 0) return;
  nativeRequestFrame(() => {
    const presented = performance.now();
    for (const written of pending) latency.nextFrame.push(presented - written);
  });
}

function outputLine(index: number): string {
  const suffix =
    index % 10 === 0 ? " 界 é 🧑‍💻 \x1b[3mitalic\x1b[0m \x1b[1mbold\x1b[0m" : "";
  return (
    `${String(index).padStart(8, "0")} ${"terminal-output ".repeat(Math.ceil(columns / 16))}`.slice(
      0,
      columns - 30,
    ) +
    suffix +
    "\r\n"
  );
}

function write(pane: Pane, data: string): number {
  pane.writes.push(performance.now());
  pane.terminal.write(data);
  pane.renderer.notifyWrite();
  return data.length;
}

function writeLines(pane: Pane, lines: number): number {
  let output = "";
  for (let index = 0; index < lines; index += 1)
    output += outputLine(sequence + index);
  return write(pane, output);
}

function frame(): Promise<void> {
  return new Promise((resolve) => nativeRequestFrame(() => resolve()));
}

const panes: Pane[] = [];
for (let index = 0; index < count; index += 1)
  panes.push(await createPane(index));
for (const pane of panes) writeLines(pane, Math.max(200, rows * 2));
sequence += Math.max(200, rows * 2);
await frame();
await frame();

async function run(steps: number, busy: "all" | "one") {
  latency.acknowledged = [];
  latency.nextFrame = [];
  const before = panes.map((pane) => ({
    ...pane.renderer.metrics,
    acknowledgements: pane.acknowledgements,
  }));
  const composited = surface?.compositedFrames ?? 0;
  const writeMilliseconds: number[] = [];
  frameCallbacks = [];
  let bytes = 0;
  const started = performance.now();
  for (let step = 0; step < steps; step += 1) {
    const writeStarted = performance.now();
    for (const pane of busy === "all" ? panes : panes.slice(0, 1))
      bytes += writeLines(pane, 10);
    sequence += 10;
    writeMilliseconds.push(performance.now() - writeStarted);
    await frame();
  }
  await frame();
  await frame();
  const elapsed = performance.now() - started;
  return {
    elapsed,
    bytes,
    writeMilliseconds,
    frameCallbacks: frameCallbacks.slice(),
    composited: (surface?.compositedFrames ?? 0) - composited,
    latency: {
      acknowledged: latency.acknowledged.slice(),
      nextFrame: latency.nextFrame.slice(),
    },
    panes: panes.map((pane, index) => ({
      submittedFrames:
        pane.renderer.metrics.submittedFrames - before[index]!.submittedFrames,
      acknowledgements: pane.acknowledgements - before[index]!.acknowledgements,
      rebuiltRows:
        pane.renderer.metrics.rebuiltRows - before[index]!.rebuiltRows,
    })),
    errors: errors.slice(),
  };
}

function outputs(): string[] {
  return panes.map((pane) =>
    pane.state
      .readRows()
      .map((row) =>
        row.cells
          .map((cell) => cell.text)
          .join("")
          .trimEnd(),
      )
      .join("\n"),
  );
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await frame();
}

Object.assign(window, {
  __fleet: {
    run,
    outputs,
    settle,
    info: () => ({
      count,
      columns,
      rows,
      shared,
      dpr: devicePixelRatio,
      canvases: document.querySelectorAll("canvas").length,
      surface: surface
        ? { width: surface.canvas.width, height: surface.canvas.height }
        : undefined,
      pane: { width: panes[0]!.canvas.width, height: panes[0]!.canvas.height },
    }),
    rects: () =>
      panes.map((pane) => {
        const rect = pane.canvas.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }),
  },
});
