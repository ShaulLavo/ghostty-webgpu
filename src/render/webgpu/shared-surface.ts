import type { FrameCoordinator } from "../shared/frame-coordinator.js";

/** Where a WebGPU renderer draws a frame: its own canvas, or a pane of a shared surface. */
export interface RenderTarget {
  readonly compositor?: SurfaceCompositor;
  configure(device: GPUDevice, format: GPUTextureFormat): void;
  unconfigure(): void;
  view(): GPUTextureView;
}

export interface SurfaceCompositor {
  encode(device: GPUDevice): GPUCommandBuffer | undefined;
}

export function canvasTarget(context: GPUCanvasContext): RenderTarget {
  return {
    configure(device, format) {
      context.configure({
        alphaMode: "premultiplied",
        device,
        format,
        usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
      });
    },
    unconfigure() {
      context.unconfigure();
    },
    view: () => context.getCurrentTexture().createView(),
  };
}

interface Pane {
  readonly element: HTMLCanvasElement;
  device?: GPUDevice;
  format?: GPUTextureFormat;
  texture?: GPUTexture;
  view?: GPUTextureView;
  presented: boolean;
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * One presented canvas behind every terminal laid out inside `container`. Each terminal draws
 * into a retained pane texture; the coordinated frame copies every pane into the canvas once.
 * The canvas sits under the container's content and scrolls with it.
 */
export class WebGpuSharedSurface implements SurfaceCompositor {
  readonly canvas: HTMLCanvasElement;
  private readonly context: GPUCanvasContext;
  private readonly panes = new Set<Pane>();
  private readonly resizeObserver: ResizeObserver;
  private coordinator?: FrameCoordinator;
  private device?: GPUDevice;
  private format?: GPUTextureFormat;
  private compositeRequested = false;
  compositedFrames = 0;

  constructor(readonly container: HTMLElement) {
    const canvas = container.ownerDocument.createElement("canvas");
    canvas.className = "ghostty-webgpu-shared-surface";
    // Below the container's content, above its background; the container becomes a stacking context.
    canvas.style.cssText =
      "position:absolute;left:0;top:0;z-index:-1;pointer-events:none;display:block";
    container.style.isolation = "isolate";
    container.prepend(canvas);
    const context = canvas.getContext("webgpu");
    if (!context)
      throw new Error("Unable to create a shared WebGPU canvas context");
    this.canvas = canvas;
    this.context = context;
    this.resizeObserver = new ResizeObserver(() => this.requestComposite());
    this.resizeObserver.observe(container);
  }

  createTarget(
    element: HTMLCanvasElement,
    coordinator: FrameCoordinator,
  ): RenderTarget {
    this.coordinator ??= coordinator;
    const pane: Pane = { element, presented: false };
    this.panes.add(pane);
    this.resizeObserver.observe(element);
    return {
      compositor: this,
      configure: (device, format) => {
        pane.device = device;
        pane.format = format;
        this.allocate(pane);
      },
      unconfigure: () => {
        pane.texture?.destroy();
        pane.texture = undefined;
        pane.view = undefined;
        pane.presented = false;
        if (!this.panes.delete(pane)) return;
        this.resizeObserver.unobserve(element);
        this.requestComposite();
      },
      view: () => {
        if (
          !pane.texture ||
          pane.texture.width !== element.width ||
          pane.texture.height !== element.height
        )
          this.allocate(pane);
        pane.presented = true;
        return pane.view!;
      },
    };
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.context.unconfigure();
    this.canvas.remove();
  }

  encode(device: GPUDevice): GPUCommandBuffer | undefined {
    this.compositeRequested = false;
    if (this.device !== device) this.configure(device);
    this.fitCanvas();
    const target = this.context.getCurrentTexture();
    const encoder = device.createCommandEncoder();
    const origin = this.canvas.getBoundingClientRect();
    const scale = this.canvas.width / Math.max(1, origin.width);
    for (const pane of this.panes)
      this.copyPane(encoder, pane, target, origin, scale);
    this.compositedFrames += 1;
    return encoder.finish();
  }

  private copyPane(
    encoder: GPUCommandEncoder,
    pane: Pane,
    target: GPUTexture,
    origin: DOMRect,
    scale: number,
  ): void {
    if (!pane.texture || !pane.presented || pane.device !== this.device) return;
    const box = contentBox(pane.element);
    if (!box) return;
    const left = Math.round((box.left - origin.left) * scale);
    const top = Math.round((box.top - origin.top) * scale);
    const clip = clipRect(pane.element, this.container, origin, scale);
    const x0 = Math.max(left, clip.left, 0);
    const y0 = Math.max(top, clip.top, 0);
    const x1 = Math.min(left + pane.texture.width, clip.right, target.width);
    const y1 = Math.min(top + pane.texture.height, clip.bottom, target.height);
    if (x1 <= x0 || y1 <= y0) return;
    encoder.copyTextureToTexture(
      { texture: pane.texture, origin: [x0 - left, y0 - top] },
      { texture: target, origin: [x0, y0] },
      [x1 - x0, y1 - y0],
    );
  }

  private allocate(pane: Pane): void {
    if (!pane.device || !pane.format)
      throw new Error("Shared surface pane is not configured");
    pane.texture?.destroy();
    pane.texture = pane.device.createTexture({
      format: pane.format,
      size: [Math.max(1, pane.element.width), Math.max(1, pane.element.height)],
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    pane.view = pane.texture.createView();
    pane.presented = false;
  }

  private configure(device: GPUDevice): void {
    this.device = device;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      alphaMode: "premultiplied",
      device,
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
    });
  }

  private fitCanvas(): void {
    const ratio =
      this.container.ownerDocument.defaultView?.devicePixelRatio ?? 1;
    const cssWidth = this.container.scrollWidth;
    const cssHeight = this.container.scrollHeight;
    const width = Math.max(1, Math.round(cssWidth * ratio));
    const height = Math.max(1, Math.round(cssHeight * ratio));
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.style.width = `${width / ratio}px`;
    this.canvas.style.height = `${height / ratio}px`;
  }

  private requestComposite(): void {
    const coordinator = this.coordinator;
    if (this.compositeRequested || !coordinator) return;
    this.compositeRequested = true;
    coordinator.requestFrame(() => {
      const device =
        this.device ??
        Array.from(this.panes).find((pane) => pane.device)?.device;
      if (!device || !this.compositeRequested) return;
      coordinator.submit({
        owner: this,
        device,
        command: device.createCommandEncoder().finish(),
        compositor: this,
        commit() {},
        notify() {},
        failed: (cause) =>
          queueMicrotask(() => {
            throw cause;
          }),
      });
    });
  }
}

function contentBox(element: HTMLElement): Rect | undefined {
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return undefined;
  if (!element.checkVisibility({ visibilityProperty: true })) return undefined;
  const style = getComputedStyle(element);
  return {
    left: rect.left + element.clientLeft + parseFloat(style.paddingLeft),
    top: rect.top + element.clientTop + parseFloat(style.paddingTop),
    right: rect.right,
    bottom: rect.bottom,
  };
}

// Rectangular overflow clips between a pane and the surface container, in canvas pixels.
function clipRect(
  element: HTMLElement,
  container: HTMLElement,
  origin: DOMRect,
  scale: number,
): Rect {
  const clip: Rect = {
    left: -Infinity,
    top: -Infinity,
    right: Infinity,
    bottom: Infinity,
  };
  for (
    let node = element.parentElement;
    node && node !== container;
    node = node.parentElement
  ) {
    if (getComputedStyle(node).overflow === "visible") continue;
    const rect = node.getBoundingClientRect();
    clip.left = Math.max(
      clip.left,
      Math.round((rect.left + node.clientLeft - origin.left) * scale),
    );
    clip.top = Math.max(
      clip.top,
      Math.round((rect.top + node.clientTop - origin.top) * scale),
    );
    clip.right = Math.min(
      clip.right,
      Math.round(
        (rect.left + node.clientLeft + node.clientWidth - origin.left) * scale,
      ),
    );
    clip.bottom = Math.min(
      clip.bottom,
      Math.round(
        (rect.top + node.clientTop + node.clientHeight - origin.top) * scale,
      ),
    );
  }
  return clip;
}
