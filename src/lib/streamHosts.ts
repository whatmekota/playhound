/**
 * Which links in a post are videos, and from where.
 *
 * The proxy (server/hosts.mjs) does the actual resolving; this only decides
 * what to offer, so a post's Patreon, Discord and shop links are left alone.
 * Hosts with a resolver of their own come first; the rest are video sites
 * yt-dlp knows, matched loosely enough to catch their usual link shapes.
 */

export type StreamHostId
  = | 'pixeldrain' | 'gofile' | 'iwara' | 'rule34video' | 'pmvhaven' | 'mega'
    | 'twitter' | 'pornhub' | 'hanime1' | 'rule34xyz' | 'rule34xxx' | 'bunkr' | 'spankbang' | 'xvideos'

export interface StreamHost {
  id: StreamHostId
  label: string
  icon: string
  /** Needs yt-dlp rather than a resolver of playhound's own. */
  ytdlp: boolean
}

interface Rule extends StreamHost {
  host: RegExp
  /** The path must look like a single video (or a folder of them), not a profile. */
  path: RegExp
}

const RULES: Rule[] = [
  { id: 'pixeldrain', label: 'Pixeldrain', icon: 'i-carbon-cloud', ytdlp: false, host: /(?:^|\.)pixeldrain\.(?:com|net)$/, path: /^\/[uld]\/\w/ },
  { id: 'gofile', label: 'Gofile', icon: 'i-carbon-box', ytdlp: false, host: /(?:^|\.)gofile\.io$/, path: /^\/d\/\w/ },
  { id: 'iwara', label: 'Iwara', icon: 'i-carbon-video', ytdlp: false, host: /(?:^|\.)iwara\.tv$/, path: /^\/videos?\/\w/ },
  { id: 'rule34video', label: 'Rule34Video', icon: 'i-carbon-video', ytdlp: false, host: /(?:^|\.)rule34video\.com$/, path: /^\/videos?\/\d/ },
  { id: 'pmvhaven', label: 'PMVHaven', icon: 'i-carbon-music', ytdlp: false, host: /(?:^|\.)pmvhaven\.com$/, path: /^\/video\/\S/ },
  { id: 'mega', label: 'MEGA', icon: 'i-carbon-cloud', ytdlp: false, host: /(?:^|\.)mega\.(?:nz|io)$/, path: /^\/(?:file|folder|#!|#F!)|^\/$/ },
  { id: 'twitter', label: 'X', icon: 'i-carbon-logo-x', ytdlp: true, host: /(?:^|\.)(?:x|twitter)\.com$/, path: /\/status\/\d/ },
  { id: 'pornhub', label: 'Pornhub', icon: 'i-carbon-video', ytdlp: true, host: /(?:^|\.)pornhub\.(?:com|org)$/, path: /^\/view_video\.php/ },
  { id: 'hanime1', label: 'Hanime1', icon: 'i-carbon-video', ytdlp: true, host: /(?:^|\.)hanime1\.me$/, path: /^\/watch/ },
  { id: 'rule34xyz', label: 'rule34.xyz', icon: 'i-carbon-video', ytdlp: true, host: /(?:^|\.)rule34\.xyz$/, path: /^\/post\/\d/ },
  { id: 'rule34xxx', label: 'rule34.xxx', icon: 'i-carbon-video', ytdlp: true, host: /(?:^|\.)rule34\.xxx$/, path: /[?&]id=\d/ },
  { id: 'bunkr', label: 'Bunkr', icon: 'i-carbon-box', ytdlp: true, host: /(?:^|\.)bunkr+\.[a-z]+$/, path: /^\/[fv]\/\w/ },
  { id: 'spankbang', label: 'SpankBang', icon: 'i-carbon-video', ytdlp: true, host: /(?:^|\.)spankbang\.com$/, path: /^\/\w+\/video\// },
  { id: 'xvideos', label: 'XVideos', icon: 'i-carbon-video', ytdlp: true, host: /(?:^|\.)xvideos\.com$/, path: /^\/video/ },
]

/** The host a link plays from, or null when it is not a video link. */
export function detectStreamHost(href: string): StreamHost | null {
  let u: URL
  try {
    u = new URL(href)
  }
  catch {
    return null
  }
  if (!/^https?:$/.test(u.protocol))
    return null
  // MEGA puts the whole address after the #, so test the path and the hash.
  const where = u.pathname + u.search + (u.hostname.includes('mega') ? u.hash : '')
  const rule = RULES.find(r => r.host.test(u.hostname) && r.path.test(where))
  if (!rule)
    return null
  const { host: _h, path: _p, ...host } = rule
  return host
}

/** What the proxy's /resolve answers. */
export interface StreamSource {
  label: string
  height: number
  size: number | null
  kind: 'file' | 'hls'
  url: string
}

export interface StreamItem {
  title: string
  size: number | null
  sources: StreamSource[]
}

export interface ResolvedStream {
  host: string
  label: string
  items: StreamItem[]
}
