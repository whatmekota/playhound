import type { SaveAsResult } from '~/lib/scriptFiles'
import { fileExists, saveTextAs, writeTextFile } from '~/lib/scriptFiles'
import { useLibraryStore } from '~/stores/libraryStore'

/**
 * Save a new funscript beside a video: straight into the video's library
 * folder when the app can write there (never over a file that exists: a
 * number is added instead), otherwise through the save dialog or a
 * download. For anything that makes a script from scratch (a recording, a
 * generated script); edits to a loaded script save through the editor.
 * Call from a click: it may ask for permission to write to the folder.
 */
export async function saveScriptBeside(
  video: File | null,
  name: string,
  text: string,
): Promise<SaveAsResult | { kind: 'beside', file: File }> {
  const dir = video ? await useLibraryStore().writableDirOf(video) : null
  if (!dir)
    return saveTextAs(text, name)
  const base = name.replace(/\.funscript$/i, '')
  let free = name
  for (let n = 2; await fileExists(dir, free); n++)
    free = `${base} ${n}.funscript`
  return { kind: 'beside', file: await writeTextFile(dir, free, text) }
}
