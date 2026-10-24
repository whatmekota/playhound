import { ref } from 'vue'
import { toast } from '~/composables/useToast'

export type MediaKind = 'image' | 'video'

// Some containers (mkv, avi) come through with an empty MIME type, so the
// extension is the fallback rather than the rule.
const IMAGE_EXT = /\.(?:jpe?g|png|gif|webp|avif|bmp|svg)$/i
const VIDEO_EXT = /\.(?:mp4|m4v|webm|mkv|mov|ogv|avi)$/i

export function mediaKind(file: File): MediaKind | null {
  if (file.type.startsWith('image/') || IMAGE_EXT.test(file.name))
    return 'image'
  if (file.type.startsWith('video/') || VIDEO_EXT.test(file.name))
    return 'video'
  return null
}

/** Opens the system file picker for images and videos. */
export function pickMediaFiles(onPicked: (files: File[]) => void) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*,video/*'
  input.multiple = true
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []).filter(f => mediaKind(f))
    if (files.length)
      onPicked(files)
  }, { once: true })
  input.click()
}

function hasFiles(e: DragEvent) {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

/**
 * File drop target for a canvas view.
 *
 * The shell listens for drops on its root to play a video straight away; a
 * canvas view wants the files for itself, so every handler here stops the
 * event before it bubbles that far. Leave events are stopped too, otherwise
 * the shell's enter/leave counter drifts and its overlay flickers on when the
 * pointer moves from here to the nav.
 */
export function useMediaDrop(onFiles: (files: File[], e: DragEvent) => void) {
  const over = ref(false)
  let depth = 0

  function dragenter(e: DragEvent) {
    if (!hasFiles(e))
      return
    e.stopPropagation()
    e.preventDefault()
    depth++
    over.value = true
  }

  function dragover(e: DragEvent) {
    if (!hasFiles(e))
      return
    e.stopPropagation()
    e.preventDefault()
    if (e.dataTransfer)
      e.dataTransfer.dropEffect = 'copy'
  }

  function dragleave(e: DragEvent) {
    if (!hasFiles(e))
      return
    e.stopPropagation()
    depth = Math.max(0, depth - 1)
    if (depth === 0)
      over.value = false
  }

  function drop(e: DragEvent) {
    if (!hasFiles(e))
      return
    e.stopPropagation()
    e.preventDefault()
    depth = 0
    over.value = false
    const files = Array.from(e.dataTransfer?.files ?? []).filter(f => mediaKind(f))
    if (!files.length) {
      toast.warn('Nothing to add from that drop', { detail: 'Images and video files only' })
      return
    }
    onFiles(files, e)
  }

  return { over, handlers: { dragenter, dragover, dragleave, drop } }
}
