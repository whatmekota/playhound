/**
 * Files from a library folder on Android, as File objects the rest of the app
 * can use unchanged.
 *
 * A folder picked through Android's Storage Access Framework is a tree of
 * content:// URIs the WebView cannot read itself. The Folders plugin
 * (android/…/folders) lists them and streams them from a small HTTP server on
 * 127.0.0.1, with byte ranges. A NativeFile stands for one of them: name, size
 * and date are real, and reading it (text(), arrayBuffer(), slice()…) fetches
 * from that server, a slice as a Range request. URL.createObjectURL() on one
 * gives the server's URL for it (installObjectUrls), so a <video> streams and
 * seeks in a file of any size.
 */

/** A file as the plugin lists it. */
export interface NativeFileInfo {
  /** content:// document URI. */
  uri: string
  name: string
  /** Bytes; -1 when the provider does not say. */
  size: number
  /** ms since the epoch; 0 when the provider does not say. */
  modified: number
  mime: string
}

let mediaBase: string | null = null

/** The media server's address, "http://127.0.0.1:<port>/<token>/". */
export function setMediaBase(base: string | null) {
  mediaBase = base
}

export function getMediaBase() {
  return mediaBase
}

/** A URL from the media server: such a <video> needs crossorigin="anonymous" to be drawn on a canvas. */
export function isNativeMediaUrl(url: string | null | undefined): boolean {
  return !!url && !!mediaBase && url.startsWith(mediaBase)
}

/** The server's URL for a file. */
export function mediaUrlFor(uri: string): string {
  if (!mediaBase)
    throw new DOMException('The media server is not running', 'NotReadableError')
  return `${mediaBase}f?u=${encodeURIComponent(uri)}`
}

/** Blob.slice()'s arithmetic: [start, end) within `size`, negatives from the end. */
export function sliceBounds(size: number, start?: number, end?: number): [number, number] {
  const rel = (v: number | undefined, fallback: number) => {
    if (v === undefined)
      return fallback
    const n = Number.isNaN(v) ? 0 : Math.trunc(v)
    return n < 0 ? Math.max(size + n, 0) : Math.min(n, size)
  }
  const s = rel(start, 0)
  const e = rel(end, size)
  return [s, Math.max(e, s)]
}

/** The bytes [from, to) of a file; the whole file when that is what it asks for. */
async function fetchPart(uri: string, from: number, to: number, size: number): Promise<Response> {
  if (to <= from)
    return new Response(new Uint8Array(0))
  const whole = from === 0 && (size < 0 || to >= size)
  const res = await fetch(mediaUrlFor(uri), whole ? undefined : { headers: { Range: `bytes=${from}-${to - 1}` } })
  if (!res.ok)
    throw new DOMException(`Could not read the file (${res.status})`, 'NotReadableError')
  return res
}

function lazyStream(open: () => Promise<Response>): ReadableStream<Uint8Array<ArrayBuffer>> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(ctl) {
      reader ??= (await open()).body!.getReader()
      const { done, value } = await reader.read()
      if (done)
        ctl.close()
      else
        ctl.enqueue(value as Uint8Array<ArrayBuffer>)
    },
    cancel: () => reader?.cancel(),
  })
}

/** A part of a NativeFile (what its slice() returns). */
export class NativeBlob extends Blob {
  constructor(readonly nativeUri: string, readonly from: number, readonly to: number, private readonly fileSize: number, private readonly mime = '') {
    super([])
  }

  override get size() {
    return this.to - this.from
  }

  override get type() {
    return this.mime
  }

  override slice(start?: number, end?: number, type?: string): Blob {
    const [s, e] = sliceBounds(this.size, start, end)
    return new NativeBlob(this.nativeUri, this.from + s, this.from + e, this.fileSize, type ?? '')
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    return (await fetchPart(this.nativeUri, this.from, this.to, this.fileSize)).arrayBuffer()
  }

  override async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await this.arrayBuffer())
  }

  override async text(): Promise<string> {
    return (await fetchPart(this.nativeUri, this.from, this.to, this.fileSize)).text()
  }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    return lazyStream(() => fetchPart(this.nativeUri, this.from, this.to, this.fileSize))
  }
}

/** A file in a library folder on Android. */
export class NativeFile extends File {
  readonly nativeUri: string
  private readonly bytesLong: number

  constructor(info: NativeFileInfo) {
    super([], info.name, { lastModified: info.modified || 0, type: info.mime && info.mime !== 'application/octet-stream' ? info.mime : '' })
    this.nativeUri = info.uri
    this.bytesLong = info.size < 0 ? 0 : info.size
  }

  override get size() {
    return this.bytesLong
  }

  /** Where the media server streams it from. */
  get mediaUrl() {
    return mediaUrlFor(this.nativeUri)
  }

  override slice(start?: number, end?: number, type?: string): Blob {
    const [s, e] = sliceBounds(this.size, start, end)
    return new NativeBlob(this.nativeUri, s, e, this.size, type ?? '')
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    return (await fetchPart(this.nativeUri, 0, this.size, this.size)).arrayBuffer()
  }

  override async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await this.arrayBuffer())
  }

  override async text(): Promise<string> {
    return (await fetchPart(this.nativeUri, 0, this.size, this.size)).text()
  }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    return lazyStream(() => fetchPart(this.nativeUri, 0, this.size, this.size))
  }
}

let installed = false

/**
 * URL.createObjectURL(nativeFile) → the media server's URL for it, so every
 * place that plays or decodes a library file (the player, thumbnails, scrub
 * previews, the share card) works as it is. Anything else is passed on.
 */
export function installObjectUrls() {
  if (installed)
    return
  installed = true
  const original = URL.createObjectURL.bind(URL)
  URL.createObjectURL = (obj: Blob | MediaSource) => (obj instanceof NativeFile ? obj.mediaUrl : original(obj))
}
