/**
 * One question before the loaded scripts are replaced: "you have unsaved
 * edits — save, discard or stay?". The script editor answers it; playback
 * and script loading ask it, without having to know about the editor.
 *
 * `auto` is for changes nobody asked for at that moment (a video ending and
 * the next one starting): those are refused rather than interrupted by a
 * dialog.
 */
export type LeaveGuard = (action: string, auto: boolean) => Promise<boolean> | boolean

let guard: LeaveGuard | null = null

export function setLeaveGuard(g: LeaveGuard): () => void {
  guard = g
  return () => {
    if (guard === g)
      guard = null
  }
}

/** Whether it is fine to go ahead with `action` ("Play another video"). */
export async function mayLeave(action: string, auto = false): Promise<boolean> {
  return guard ? guard(action, auto) : true
}
