import {
  invertMatrix,
  multiplyMatrices,
  scaleOutputMatrix,
} from '../matrix'
import { Glass, Html, type TraversedSceneLayer } from '../scene'
import {
  CONTENT_ATLAS_PADDING,
  getTextureBucketSize,
  packContentAtlas,
  type GlassContentEntry,
} from './content'
import {
  createAdaptiveBlurResources,
  destroyAdaptiveBlurResources,
  renderAdaptiveBlur,
  type AdaptiveBlurResources,
} from './adaptive-blur'
import { GPU_BUFFER_USAGE, GPU_TEXTURE_USAGE } from './gpu-constants'
import {
  GpuStructArrayBuffer,
  type GpuStructDefinition,
} from './gpu-layout'
import {
  copyTextureRegion,
  createAdaptiveBlurTargetChain,
  createRenderTarget,
  destroyAdaptiveBlurTargetChain,
} from './gpu-targets'
import { matrixToCssTransform, type FlattenedContainer } from './interaction'
import { getSortedGlassHtmlLayers, getSortedGlassLayers } from './scene-order'
import { ContentDataLayout } from './shader-layouts'
import type { GlassContentRange, SceneHtmlEntry } from './content-source'
export type { FlattenedContainer } from './interaction'

/** Typed GPU buffer used for glass content atlas entries. */
type ContentDataBuffer = GpuStructArrayBuffer<GpuStructDefinition<typeof ContentDataLayout>>

/** Chrome's experimental queue extension for copying DOM elements to textures. */
type GPUQueueWithElementCopy = GPUQueue & {
  copyElementImageToTexture: (
    source: { source: Element },
    destination: {
      destination: GPUImageCopyTextureTagged
      width: number
      height: number
    },
  ) => void
}

/** Paint event payload emitted by canvas layout subtree updates. */
type CanvasPaintEvent = Event & {
  changedElements?: readonly Element[]
}

/** Previous atlas location and copied size used when copying forward on repack. */
type PreviousGlassContentAtlasEntry = {
  copiedDeviceWidth: number
  copiedDeviceHeight: number
  atlasX: number
  atlasY: number
}

/** Dependencies needed by DOM content syncing without owning the renderer. */
type DomContentSyncOptions = {
  targetCanvas: HTMLCanvasElement
  getCurrentDpr: () => number
}

/** Returns whether a paint event changed any managed HTML host or descendant. */
function changedElementsIncludeHost(changedElements: readonly Element[], hosts: Set<HTMLDivElement>) {
  for (const element of changedElements) {
    for (const host of hosts) {
      if (element === host || host.contains(element)) {
        return true
      }
    }
  }

  return false
}

/** Mounts and updates a managed HTML host's transform and z-index. */
function syncHtmlHost(host: HTMLDivElement, canvas: HTMLCanvasElement, transform: string, zIndex: string) {
  if (host.parentElement !== canvas) {
    canvas.append(host)
  }
  if (host.style.transform !== transform) {
    host.style.transform = transform
  }
  if (host.style.zIndex !== zIndex) {
    host.style.zIndex = zIndex
  }
}

/** Reorders managed HTML hosts to match the renderer's visual ordering. */
function syncHtmlHostDomOrder(canvas: HTMLCanvasElement, hostOrder: Map<Html, number>) {
  // Chrome's experimental layoutsubtree hit testing can follow canvas child order
  // even when the hosts have matching CSS z-index values, so keep DOM order in
  // sync with the renderer's visual order. The comparison avoids re-appending
  // every frame, which would continuously invalidate the canvas paint cache.
  const desiredHosts = [...hostOrder.entries()]
    .sort((left, right) => left[1] - right[1])
    .map(([html]) => html.host)
    .filter((host) => host.parentElement === canvas)
  const managedHosts = new Set(desiredHosts)
  const currentHosts = Array.from(canvas.children).filter((child) => managedHosts.has(child as HTMLDivElement))

  if (
    currentHosts.length === desiredHosts.length &&
    currentHosts.every((host, index) => host === desiredHosts[index])
  ) {
    return
  }

  for (const host of desiredHosts) {
    canvas.append(host)
  }
}

/** Converts copied device pixels into the copied extent in local CSS pixels. */
export function getCopiedCssSize(copiedDeviceSize: number, deviceSize: number, cssSize: number) {
  if (copiedDeviceSize <= 0 || deviceSize <= 0 || cssSize <= 0) {
    return 0
  }
  return (copiedDeviceSize / deviceSize) * cssSize
}

/** Converts a local CSS coordinate to a texture UV scale factor. */
export function getTextureUvScale(deviceSize: number, cssSize: number, textureSize: number) {
  if (deviceSize <= 0 || cssSize <= 0 || textureSize <= 0) {
    return 0
  }
  return deviceSize / cssSize / textureSize
}

/** Copies one DOM element into a WebGPU texture using the current HTML-in-Canvas API. */
export function copyElementToTexture(
  queue: GPUQueue,
  source: Element,
  width: number,
  height: number,
  texture: GPUTexture,
) {
  ;(queue as GPUQueueWithElementCopy).copyElementImageToTexture(
    { source },
    {
      destination: { texture },
      width,
      height,
    },
  )
}

/** Synchronizes DOM-backed HTML hosts, textures, atlases, and content buffers. */
export class DomContentSync {
  /** Hosts for scene-attached HTML nodes currently managed by the renderer. */
  readonly sceneHtmlHosts = new Set<HTMLDivElement>()
  /** Hosts for glass-attached HTML nodes currently managed by the renderer. */
  readonly glassContentHosts = new Set<HTMLDivElement>()

  private device: GPUDevice | null = null
  private presentationFormat: GPUTextureFormat | null = null
  private readonly sceneHtmlEntries = new Map<Html, SceneHtmlEntry>()
  private readonly glassContentEntries = new Map<Html, GlassContentEntry>()
  private readonly glassContentRanges = new Map<Glass, GlassContentRange>()
  private glassContentOrder: GlassContentEntry[] = []
  private needsSceneHtmlCopy = false
  private needsSceneHtmlFilter = false
  private needsContentCopy = false
  private needsContentFilter = false
  private contentEntriesBuffer: ContentDataBuffer | null = null
  private glassContentAtlas: GPUTexture | null = null
  private glassContentAtlasWidth = 0
  private glassContentAtlasHeight = 0
  private sampler: GPUSampler | null = null
  private htmlBlurResources: AdaptiveBlurResources | null = null

  /** Creates a DOM content sync helper for one renderer canvas. */
  constructor(private readonly options: DomContentSyncOptions) {}

  /** Current atlas texture for glass-attached HTML content, if any exists. */
  get atlasTexture() {
    return this.glassContentAtlas
  }

  /** Binding resource for content entries, or null before GPU allocation. */
  get contentEntriesBindingResource() {
    return this.contentEntriesBuffer?.buffer ? this.contentEntriesBuffer.bindingResource : null
  }

  /** Attaches GPU resources and creates the fallback content-entry buffer. */
  setDevice(device: GPUDevice, presentationFormat: GPUTextureFormat) {
    this.device = device
    this.presentationFormat = presentationFormat
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })
    destroyAdaptiveBlurResources(this.htmlBlurResources)
    this.htmlBlurResources = createAdaptiveBlurResources(device, presentationFormat)
    this.contentEntriesBuffer?.destroy()
    this.contentEntriesBuffer = new GpuStructArrayBuffer(
      device,
      ContentDataLayout,
      GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_DST,
    )
    this.contentEntriesBuffer.ensureCapacity(0)
  }

  /** Removes DOM hosts and destroys all GPU resources owned by this helper. */
  destroy() {
    for (const entry of this.sceneHtmlEntries.values()) {
      entry.texture?.destroy()
      destroyAdaptiveBlurTargetChain(entry.blurTargetChain)
      entry.html.host.remove()
    }
    this.sceneHtmlEntries.clear()
    this.sceneHtmlHosts.clear()

    for (const entry of this.glassContentEntries.values()) {
      entry.sourceTexture?.destroy()
      destroyAdaptiveBlurTargetChain(entry.blurTargetChain)
      entry.html.host.remove()
    }
    this.glassContentEntries.clear()
    this.glassContentRanges.clear()
    this.glassContentOrder = []
    this.glassContentHosts.clear()
    this.glassContentAtlas?.destroy()
    this.glassContentAtlas = null
    this.glassContentAtlasWidth = 0
    this.glassContentAtlasHeight = 0
    this.contentEntriesBuffer?.destroy()
    this.contentEntriesBuffer = null
    destroyAdaptiveBlurResources(this.htmlBlurResources)
    this.htmlBlurResources = null
    this.sampler = null
  }

  /** Handles canvas paint events by copying changed DOM hosts into textures. */
  handlePaintEvent(event: Event) {
    if (!this.device) {
      return
    }

    const changedElements = (event as CanvasPaintEvent).changedElements
    const hasChangedElements = Array.isArray(changedElements)
    const shouldCopySceneHtml =
      this.needsSceneHtmlCopy ||
      !hasChangedElements ||
      changedElementsIncludeHost(changedElements, this.sceneHtmlHosts)
    const shouldCopyContent =
      this.needsContentCopy ||
      !hasChangedElements ||
      changedElementsIncludeHost(changedElements, this.glassContentHosts)

    if (shouldCopySceneHtml) {
      this.copySceneHtmlTextures()
    }

    if (this.needsSceneHtmlFilter) {
      this.filterSceneHtmlTextures()
    }

    if (shouldCopyContent) {
      this.copyGlassContentAtlas()
    }

    if (this.needsContentFilter) {
      this.filterGlassContentAtlas()
    }
  }

  /** Attempts any pending DOM-to-texture copies immediately. */
  copyPending() {
    if (this.needsSceneHtmlCopy) {
      this.copySceneHtmlTextures()
    }

    if (this.needsSceneHtmlFilter) {
      this.filterSceneHtmlTextures()
    }

    if (this.needsContentCopy) {
      this.copyGlassContentAtlas()
    }

    if (this.needsContentFilter) {
      this.filterGlassContentAtlas()
    }
  }

  /** Synchronizes managed HTML hosts and GPU content state with the scene. */
  sync(
    layers: TraversedSceneLayer[],
    containers: FlattenedContainer[],
    hostOrder: Map<Html, number>,
  ) {
    this.syncSceneHtml(layers, hostOrder)
    this.syncGlassContent(containers, hostOrder)
    syncHtmlHostDomOrder(this.options.targetCanvas, hostOrder)
  }

  /** Returns GPU state for a scene-attached HTML node. */
  getSceneHtmlEntry(html: Html) {
    return this.sceneHtmlEntries.get(html) ?? null
  }

  /** Returns the storage-buffer range for a glass node's attached HTML. */
  getGlassContentRange(glass: Glass) {
    return this.glassContentRanges.get(glass) ?? null
  }

  /** Removes one scene-attached HTML entry and optionally keeps its host mounted. */
  private removeSceneHtmlEntry(html: Html, keepHostMounted: boolean) {
    const entry = this.sceneHtmlEntries.get(html)
    if (!entry) {
      return
    }

    entry.texture?.destroy()
    destroyAdaptiveBlurTargetChain(entry.blurTargetChain)
    this.sceneHtmlHosts.delete(html.host)
    this.sceneHtmlEntries.delete(html)
    if (!keepHostMounted) {
      html.host.remove()
    }
  }

  /** Removes one glass-attached HTML entry and optionally keeps its host mounted. */
  private removeGlassContentEntry(html: Html, keepHostMounted: boolean) {
    const entry = this.glassContentEntries.get(html)
    if (!entry) {
      return
    }

    entry.sourceTexture?.destroy()
    destroyAdaptiveBlurTargetChain(entry.blurTargetChain)
    this.glassContentHosts.delete(html.host)
    this.glassContentEntries.delete(html)
    if (!keepHostMounted) {
      html.host.remove()
    }
  }

  /** Synchronizes textures and transforms for scene-attached HTML layers. */
  private syncSceneHtml(layers: TraversedSceneLayer[], hostOrder: Map<Html, number>) {
    const activeHtml = new Set<Html>()
    let layoutChanged = false
    let contentChanged = false
    const currentDpr = this.options.getCurrentDpr()

    for (const layer of layers) {
      if (!(layer.child instanceof Html) || layer.child.width <= 0 || layer.child.height <= 0) {
        continue
      }

      const html = layer.child
      activeHtml.add(html)

      let entry = this.sceneHtmlEntries.get(html)
      if (!entry) {
        entry = {
          html,
          texture: null,
          filteredTexture: null,
          elementVersion: -1,
          blur: -1,
          width: -1,
          height: -1,
          deviceWidth: 0,
          deviceHeight: 0,
          copiedDeviceWidth: 0,
          copiedDeviceHeight: 0,
          textureWidth: 0,
          textureHeight: 0,
          blurTargetChain: null,
          transform: layer.transform,
          inverseTransform: null,
        }
        this.sceneHtmlEntries.set(html, entry)
        layoutChanged = true
        contentChanged = true
      }

      entry.transform = layer.transform
      entry.inverseTransform = invertMatrix(scaleOutputMatrix(layer.transform, currentDpr))

      if (entry.elementVersion !== html._elementVersion) {
        entry.elementVersion = html._elementVersion
        contentChanged = true
      }

      if (entry.blur !== html.blur) {
        entry.blur = html.blur
        this.needsSceneHtmlFilter = true
      }

      const previousDeviceWidth = entry.deviceWidth
      const previousDeviceHeight = entry.deviceHeight
      const nextDeviceWidth = Math.max(1, Math.round(html.width * currentDpr))
      const nextDeviceHeight = Math.max(1, Math.round(html.height * currentDpr))
      let nextTextureWidth = entry.textureWidth
      let nextTextureHeight = entry.textureHeight
      let textureSizeChanged = false

      if (this.device) {
        nextTextureWidth = getTextureBucketSize(nextDeviceWidth, this.device.limits.maxTextureDimension2D)
        nextTextureHeight = getTextureBucketSize(nextDeviceHeight, this.device.limits.maxTextureDimension2D)
        textureSizeChanged =
          entry.textureWidth !== nextTextureWidth || entry.textureHeight !== nextTextureHeight
      }

      const contentSizeChanged =
        entry.deviceWidth !== nextDeviceWidth || entry.deviceHeight !== nextDeviceHeight
      if (
        entry.width !== html.width ||
        entry.height !== html.height ||
        contentSizeChanged
      ) {
        entry.width = html.width
        entry.height = html.height
        entry.deviceWidth = nextDeviceWidth
        entry.deviceHeight = nextDeviceHeight
        layoutChanged = true
        contentChanged = true
      }

      if (this.device && this.presentationFormat) {
        const rebuildTexture =
          !entry.texture ||
          textureSizeChanged

        if (rebuildTexture) {
          const previousTexture = entry.texture
          const nextTexture = this.device.createTexture({
            size: {
              width: nextTextureWidth,
              height: nextTextureHeight,
              depthOrArrayLayers: 1,
            },
            format: this.presentationFormat,
            // Required by Chrome's experimental DOM-to-texture copy path for scene Html layers.
            usage:
              GPU_TEXTURE_USAGE.COPY_SRC |
              GPU_TEXTURE_USAGE.TEXTURE_BINDING |
              GPU_TEXTURE_USAGE.COPY_DST |
              GPU_TEXTURE_USAGE.RENDER_ATTACHMENT,
          })

          if (previousTexture) {
            const encoder = this.device.createCommandEncoder()
            const copiedDeviceWidth = Math.min(entry.copiedDeviceWidth, previousDeviceWidth, nextTextureWidth)
            const copiedDeviceHeight = Math.min(entry.copiedDeviceHeight, previousDeviceHeight, nextTextureHeight)
            const copied = copyTextureRegion(encoder, previousTexture, nextTexture, {
              sourceX: 0,
              sourceY: 0,
              destinationX: 0,
              destinationY: 0,
              width: copiedDeviceWidth,
              height: copiedDeviceHeight,
            })

            if (copied) {
              this.device.queue.submit([encoder.finish()])
            }

            entry.copiedDeviceWidth = copiedDeviceWidth
            entry.copiedDeviceHeight = copiedDeviceHeight
          } else {
            entry.copiedDeviceWidth = 0
            entry.copiedDeviceHeight = 0
          }

          previousTexture?.destroy()
          destroyAdaptiveBlurTargetChain(entry.blurTargetChain)
          entry.texture = nextTexture
          entry.filteredTexture = null
          entry.blurTargetChain = null
          entry.textureWidth = nextTextureWidth
          entry.textureHeight = nextTextureHeight
          layoutChanged = true
          contentChanged = true
        }
      }

      if (entry.texture) {
        this.sceneHtmlHosts.add(html.host)
        syncHtmlHost(
          html.host,
          this.options.targetCanvas,
          matrixToCssTransform(layer.transform),
          String(hostOrder.get(html) ?? 0),
        )
      }
    }

    for (const html of [...this.sceneHtmlEntries.keys()]) {
      if (!activeHtml.has(html)) {
        this.removeSceneHtmlEntry(html, hostOrder.has(html))
        layoutChanged = true
        contentChanged = true
      }
    }

    if (activeHtml.size === 0) {
      this.needsSceneHtmlCopy = false
      this.needsSceneHtmlFilter = false
      return
    }

    if (layoutChanged || contentChanged) {
      this.needsSceneHtmlCopy = true
    }
  }

  /** Synchronizes glass-attached HTML entries and atlas packing. */
  private syncGlassContent(containers: FlattenedContainer[], hostOrder: Map<Html, number>) {
    const activeContentHtml = new Set<Html>()
    const activeEntries: GlassContentEntry[] = []
    const nextRanges = new Map<Glass, GlassContentRange>()
    const previousAtlasTexture = this.glassContentAtlas
    const previousAtlasEntries = new Map<Html, PreviousGlassContentAtlasEntry>()
    const currentDpr = this.options.getCurrentDpr()
    let layoutChanged = false
    let contentChanged = false

    if (previousAtlasTexture) {
      for (const entry of this.glassContentEntries.values()) {
        previousAtlasEntries.set(entry.html, {
          copiedDeviceWidth: entry.copiedDeviceWidth,
          copiedDeviceHeight: entry.copiedDeviceHeight,
          atlasX: entry.atlasX,
          atlasY: entry.atlasY,
        })
      }
    }

    for (const containerEntry of containers) {
      const containerTransform = containerEntry.transform

      for (const glassLayer of getSortedGlassLayers(containerEntry.container)) {
        const glass = glassLayer.glass
        if (glass.width <= 0 || glass.height <= 0) {
          continue
        }

        const glassTransform = multiplyMatrices(containerTransform, glassLayer.transform)
        const contentStart = activeEntries.length

        for (const htmlLayer of getSortedGlassHtmlLayers(glass)) {
          const html = htmlLayer.html
          if (html.width <= 0 || html.height <= 0) {
            continue
          }

          const inverseTransform = invertMatrix(htmlLayer.transform)
          this.glassContentHosts.add(html.host)
          syncHtmlHost(
            html.host,
            this.options.targetCanvas,
            matrixToCssTransform(multiplyMatrices(glassTransform, htmlLayer.transform)),
            String(hostOrder.get(html) ?? 0),
          )

          if (!inverseTransform) {
            continue
          }
          activeContentHtml.add(html)

          let contentEntry = this.glassContentEntries.get(html)
          if (!contentEntry) {
            contentEntry = {
              html,
              glass,
              elementVersion: -1,
              blur: -1,
              width: -1,
              height: -1,
              deviceWidth: 0,
              deviceHeight: 0,
              copiedDeviceWidth: 0,
              copiedDeviceHeight: 0,
              sourceTexture: null,
              sourceTextureWidth: 0,
              sourceTextureHeight: 0,
              filteredTexture: null,
              blurTargetChain: null,
              atlasX: 0,
              atlasY: 0,
              inverseTransform,
            }
            this.glassContentEntries.set(html, contentEntry)
            layoutChanged = true
            contentChanged = true
          }

          if (contentEntry.glass !== glass) {
            contentEntry.glass = glass
            layoutChanged = true
          }

          contentEntry.inverseTransform = inverseTransform

          if (contentEntry.elementVersion !== html._elementVersion) {
            contentEntry.elementVersion = html._elementVersion
            contentChanged = true
          }

          const nextDeviceWidth = Math.max(1, Math.round(html.width * currentDpr))
          const nextDeviceHeight = Math.max(1, Math.round(html.height * currentDpr))
          let nextSourceTextureWidth = contentEntry.sourceTextureWidth
          let nextSourceTextureHeight = contentEntry.sourceTextureHeight
          let sourceTextureSizeChanged = false

          if (this.device) {
            nextSourceTextureWidth = getTextureBucketSize(nextDeviceWidth, this.device.limits.maxTextureDimension2D)
            nextSourceTextureHeight = getTextureBucketSize(nextDeviceHeight, this.device.limits.maxTextureDimension2D)
            sourceTextureSizeChanged =
              contentEntry.sourceTextureWidth !== nextSourceTextureWidth ||
              contentEntry.sourceTextureHeight !== nextSourceTextureHeight
          }

          if (
            contentEntry.width !== html.width ||
            contentEntry.height !== html.height ||
            contentEntry.deviceWidth !== nextDeviceWidth ||
            contentEntry.deviceHeight !== nextDeviceHeight
          ) {
            contentEntry.width = html.width
            contentEntry.height = html.height
            contentEntry.deviceWidth = nextDeviceWidth
            contentEntry.deviceHeight = nextDeviceHeight
            layoutChanged = true
            contentChanged = true
          }

          if (contentEntry.blur !== html.blur) {
            contentEntry.blur = html.blur
            this.needsContentFilter = true
          }

          if (this.device && this.presentationFormat) {
            const rebuildSourceTexture =
              !contentEntry.sourceTexture ||
              sourceTextureSizeChanged

            if (rebuildSourceTexture) {
              contentEntry.sourceTexture?.destroy()
              destroyAdaptiveBlurTargetChain(contentEntry.blurTargetChain)
              contentEntry.sourceTexture = createRenderTarget(
                this.device,
                this.presentationFormat,
                nextSourceTextureWidth,
                nextSourceTextureHeight,
              )
              contentEntry.sourceTextureWidth = nextSourceTextureWidth
              contentEntry.sourceTextureHeight = nextSourceTextureHeight
              contentEntry.filteredTexture = null
              contentEntry.blurTargetChain = null
              contentEntry.copiedDeviceWidth = 0
              contentEntry.copiedDeviceHeight = 0
              contentChanged = true
            }
          }

          activeEntries.push(contentEntry)
        }

        const contentCount = activeEntries.length - contentStart
        if (contentCount > 0) {
          nextRanges.set(glass, {
            start: contentStart,
            count: contentCount,
          })
        }
      }
    }

    for (const html of [...this.glassContentEntries.keys()]) {
      if (!activeContentHtml.has(html)) {
        this.removeGlassContentEntry(html, hostOrder.has(html))
        layoutChanged = true
        contentChanged = true
      }
    }

    this.glassContentOrder = activeEntries
    this.glassContentRanges.clear()
    for (const [glass, range] of nextRanges) {
      this.glassContentRanges.set(glass, range)
    }

    if (!this.device) {
      this.needsContentCopy = false
      return
    }

    if (activeEntries.length === 0) {
      this.glassContentAtlas?.destroy()
      this.glassContentAtlas = null
      this.glassContentAtlasWidth = 0
      this.glassContentAtlasHeight = 0
      this.needsContentCopy = false
      this.needsContentFilter = false
      return
    }

    if (layoutChanged || !this.glassContentAtlas) {
      const layout = packContentAtlas(activeEntries, this.device.limits.maxTextureDimension2D)
      const nextAtlasWidth = layout.width
      const nextAtlasHeight = layout.height
      const previousAtlasWidth = this.glassContentAtlasWidth
      const previousAtlasHeight = this.glassContentAtlasHeight
      const atlasLayoutChanged =
        !this.glassContentAtlas ||
        nextAtlasWidth !== this.glassContentAtlasWidth ||
        nextAtlasHeight !== this.glassContentAtlasHeight ||
        activeEntries.some((entry) => {
          const rect = layout.rects.get(entry.html)!
          return entry.atlasX !== rect.x || entry.atlasY !== rect.y
        })

      if (atlasLayoutChanged) {
        const nextAtlas = this.device.createTexture({
          size: {
            width: nextAtlasWidth,
            height: nextAtlasHeight,
            depthOrArrayLayers: 1,
          },
          format: this.presentationFormat ?? 'bgra8unorm',
          usage:
            GPU_TEXTURE_USAGE.COPY_SRC |
            GPU_TEXTURE_USAGE.TEXTURE_BINDING |
            GPU_TEXTURE_USAGE.COPY_DST |
            GPU_TEXTURE_USAGE.RENDER_ATTACHMENT,
        })

        if (previousAtlasTexture) {
          const encoder = this.device.createCommandEncoder()
          let copiedAny = false

          for (const entry of activeEntries) {
            const previousEntry = previousAtlasEntries.get(entry.html)
            const rect = layout.rects.get(entry.html)!
            if (!previousEntry) {
              entry.copiedDeviceWidth = 0
              entry.copiedDeviceHeight = 0
              continue
            }

            const sourceX = previousEntry.atlasX + CONTENT_ATLAS_PADDING
            const sourceY = previousEntry.atlasY + CONTENT_ATLAS_PADDING
            const destinationX = rect.x + CONTENT_ATLAS_PADDING
            const destinationY = rect.y + CONTENT_ATLAS_PADDING
            const copiedDeviceWidth = Math.min(
              previousEntry.copiedDeviceWidth,
              previousAtlasWidth - sourceX,
              nextAtlasWidth - destinationX,
            )
            const copiedDeviceHeight = Math.min(
              previousEntry.copiedDeviceHeight,
              previousAtlasHeight - sourceY,
              nextAtlasHeight - destinationY,
            )

            copiedAny =
              copyTextureRegion(encoder, previousAtlasTexture, nextAtlas, {
                sourceX,
                sourceY,
                destinationX,
                destinationY,
                width: copiedDeviceWidth,
                height: copiedDeviceHeight,
              }) || copiedAny

            entry.copiedDeviceWidth = Math.max(0, copiedDeviceWidth)
            entry.copiedDeviceHeight = Math.max(0, copiedDeviceHeight)
          }

          if (copiedAny) {
            this.device.queue.submit([encoder.finish()])
          }
        } else {
          for (const entry of activeEntries) {
            entry.copiedDeviceWidth = 0
            entry.copiedDeviceHeight = 0
          }
        }

        previousAtlasTexture?.destroy()
        this.glassContentAtlas = nextAtlas
        this.glassContentAtlasWidth = nextAtlasWidth
        this.glassContentAtlasHeight = nextAtlasHeight
      }

      for (const entry of activeEntries) {
        const rect = layout.rects.get(entry.html)!

        entry.atlasX = rect.x
        entry.atlasY = rect.y
      }

      this.needsContentCopy = true
      this.needsContentFilter = true
    } else if (contentChanged) {
      this.needsContentCopy = true
    }

    this.writeContentEntries(activeEntries)
  }

  /** Writes glass content metadata into the storage buffer. */
  private writeContentEntries(entries: GlassContentEntry[]) {
    if (!this.contentEntriesBuffer) {
      return
    }

    this.contentEntriesBuffer.ensureCapacity(entries.length)
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]
      const inverse = entry.inverseTransform

      this.contentEntriesBuffer.writeAt(index, {
        inverse0: {
          a: inverse.a,
          c: inverse.c,
          e: inverse.e,
          copiedWidth: getCopiedCssSize(entry.copiedDeviceWidth, entry.deviceWidth, entry.width),
        },
        inverse1: {
          b: inverse.b,
          d: inverse.d,
          f: inverse.f,
          copiedHeight: getCopiedCssSize(entry.copiedDeviceHeight, entry.deviceHeight, entry.height),
        },
        atlasRect: {
          u: (entry.atlasX + CONTENT_ATLAS_PADDING) / this.glassContentAtlasWidth,
          v: (entry.atlasY + CONTENT_ATLAS_PADDING) / this.glassContentAtlasHeight,
          uScale: getTextureUvScale(entry.deviceWidth, entry.width, this.glassContentAtlasWidth),
          vScale: getTextureUvScale(entry.deviceHeight, entry.height, this.glassContentAtlasHeight),
        },
        opacity: {
          value: entry.html.opacity,
        },
      })
    }

    this.contentEntriesBuffer.upload(entries.length)
  }

  /** Copies scene-attached HTML hosts into their individual textures. */
  private copySceneHtmlTextures() {
    if (!this.device || this.sceneHtmlEntries.size === 0) {
      this.needsSceneHtmlCopy = false
      return true
    }

    let copiedAll = true
    let copiedAny = false
    for (const entry of this.sceneHtmlEntries.values()) {
      if (!entry.texture) {
        copiedAll = false
        continue
      }

      try {
        copyElementToTexture(
          this.device.queue,
          entry.html.host,
          entry.deviceWidth,
          entry.deviceHeight,
          entry.texture,
        )
        entry.copiedDeviceWidth = entry.deviceWidth
        entry.copiedDeviceHeight = entry.deviceHeight
        copiedAny = true
      } catch (error) {
        copiedAll = false
        if (!(error instanceof DOMException && error.name === 'InvalidStateError')) {
          console.error(error)
        }
      }
    }

    if (copiedAny) {
      this.needsSceneHtmlFilter = true
    }

    this.needsSceneHtmlCopy = !copiedAll
    return copiedAll
  }

  /** Applies GPU blur to scene-attached HTML textures when requested. */
  private filterSceneHtmlTextures() {
    if (!this.device || !this.sampler || !this.htmlBlurResources) {
      this.needsSceneHtmlFilter = false
      return true
    }

    const encoder = this.device.createCommandEncoder()
    let filteredAny = false

    for (const entry of this.sceneHtmlEntries.values()) {
      entry.filteredTexture = null

      if (!entry.texture || entry.copiedDeviceWidth <= 0 || entry.copiedDeviceHeight <= 0) {
        continue
      }

      const blurRadiusPx = entry.html.blur * this.options.getCurrentDpr()
      if (blurRadiusPx <= 0) {
        continue
      }

      if (
        !entry.blurTargetChain ||
        entry.blurTargetChain.levels[0]?.width !== entry.textureWidth ||
        entry.blurTargetChain.levels[0]?.height !== entry.textureHeight
      ) {
        destroyAdaptiveBlurTargetChain(entry.blurTargetChain)
        entry.blurTargetChain = createAdaptiveBlurTargetChain(
          this.device,
          this.presentationFormat ?? 'bgra8unorm',
          entry.textureWidth,
          entry.textureHeight,
        )
      }

      entry.filteredTexture = renderAdaptiveBlur({
        device: this.device,
        sampler: this.sampler,
        encoder,
        source: entry.texture,
        radiusPx: blurRadiusPx,
        chain: entry.blurTargetChain,
        resources: this.htmlBlurResources,
      })
      filteredAny = true
    }

    if (filteredAny) {
      this.device.queue.submit([encoder.finish()])
    }

    this.needsSceneHtmlFilter = false
    return true
  }

  /** Copies glass-attached HTML hosts into per-node source textures. */
  private copyGlassContentAtlas() {
    if (!this.device || this.glassContentOrder.length === 0) {
      this.needsContentCopy = false
      return true
    }

    let copiedAll = true
    let copiedAny = false
    for (const entry of this.glassContentOrder) {
      if (!entry.sourceTexture) {
        copiedAll = false
        continue
      }

      try {
        copyElementToTexture(
          this.device.queue,
          entry.html.host,
          entry.deviceWidth,
          entry.deviceHeight,
          entry.sourceTexture,
        )
        entry.copiedDeviceWidth = entry.deviceWidth
        entry.copiedDeviceHeight = entry.deviceHeight
        copiedAny = true
      } catch (error) {
        copiedAll = false
        if (!(error instanceof DOMException && error.name === 'InvalidStateError')) {
          console.error(error)
        }
      }
    }

    if (copiedAny) {
      this.needsContentFilter = true
    }

    this.needsContentCopy = !copiedAll
    return copiedAll
  }

  /** Applies GPU blur to glass-attached HTML sources and writes the result into the content atlas. */
  private filterGlassContentAtlas() {
    if (
      !this.device ||
      !this.sampler ||
      !this.htmlBlurResources ||
      !this.glassContentAtlas ||
      this.glassContentOrder.length === 0
    ) {
      this.needsContentFilter = false
      return true
    }

    const encoder = this.device.createCommandEncoder()
    let copiedAny = false

    for (const entry of this.glassContentOrder) {
      if (!entry.sourceTexture || entry.copiedDeviceWidth <= 0 || entry.copiedDeviceHeight <= 0) {
        continue
      }

      let sourceTexture = entry.sourceTexture
      const blurRadiusPx = entry.html.blur * this.options.getCurrentDpr()
      entry.filteredTexture = null

      if (blurRadiusPx > 0) {
        if (
          !entry.blurTargetChain ||
          entry.blurTargetChain.levels[0]?.width !== entry.sourceTextureWidth ||
          entry.blurTargetChain.levels[0]?.height !== entry.sourceTextureHeight
        ) {
          destroyAdaptiveBlurTargetChain(entry.blurTargetChain)
          entry.blurTargetChain = createAdaptiveBlurTargetChain(
            this.device,
            this.presentationFormat ?? 'bgra8unorm',
            entry.sourceTextureWidth,
            entry.sourceTextureHeight,
          )
        }

        entry.filteredTexture = renderAdaptiveBlur({
          device: this.device,
          sampler: this.sampler,
          encoder,
          source: entry.sourceTexture,
          radiusPx: blurRadiusPx,
          chain: entry.blurTargetChain,
          resources: this.htmlBlurResources,
        })
        sourceTexture = entry.filteredTexture
      }

      copiedAny = copyTextureRegion(encoder, sourceTexture, this.glassContentAtlas, {
        sourceX: 0,
        sourceY: 0,
        destinationX: entry.atlasX + CONTENT_ATLAS_PADDING,
        destinationY: entry.atlasY + CONTENT_ATLAS_PADDING,
        width: entry.copiedDeviceWidth,
        height: entry.copiedDeviceHeight,
      }) || copiedAny
    }

    if (copiedAny) {
      this.writeContentEntries(this.glassContentOrder)
      this.device.queue.submit([encoder.finish()])
    }

    this.needsContentFilter = false
    return true
  }
}
