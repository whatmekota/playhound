import type { Directive } from 'vue'
import { isAndroidApp } from './android/detect'

/**
 * Let go of a media element's decoder and buffers now. A <video> taken out of
 * the page keeps both until it is garbage-collected, which on a phone can be
 * long enough for a few of them to get the WebView's renderer killed for
 * memory. Taking the src away and calling load() frees them at once.
 */
export function releaseMedia(el: HTMLMediaElement) {
  try {
    el.pause()
    el.removeAttribute('src')
    el.load()
  }
  catch {}
}

/**
 * `v-release-media` on a <video> or <audio>: released once it leaves the page.
 * Only in the Android app; elsewhere the browser's own clean-up is fine and
 * a leave transition keeps showing the last frame.
 */
export const vReleaseMedia: Directive<HTMLMediaElement> = {
  unmounted: (el) => {
    if (isAndroidApp)
      releaseMedia(el)
  },
}
