/**
 * The EroScripts forum (Discourse) as the EroScripts view reads it: the paths
 * it asks for and what it takes out of the answers. Read only: nothing here
 * writes to the forum or to anyone's account on it.
 *
 * Checked against the live forum: topic lists take `tags[]` (with
 * `match_all_tags=true` for all of them) and, for Top, `period`; search pages
 * from 1 and says `more_full_page_results` while there is more; tag search is
 * `/tags/filter/search.json`. Free Scripts itself only answers a signed-in
 * member; search and tag search answer anyone.
 */

export interface ForumTag { id: number, name: string, slug: string }

export type ListSort = 'latest' | 'top' | 'hot'
/** The periods Top offers here (the forum has `quarterly` too). */
export type TopPeriod = 'daily' | 'weekly' | 'monthly' | 'yearly' | 'all'
export type SearchOrder = 'relevance' | 'newest' | 'likes' | 'views'

/** `tags[]`, encoded: some native HTTP clients refuse bare brackets in a query. */
const TAGS_PARAM = 'tags%5B%5D'

/** A page of a topic list, by tags (all of them must match) and, for Top, a period. Pages count from 0. */
export function topicListPath(base: string, o: { sort: ListSort, tags?: readonly string[], period?: TopPeriod, page?: number }): string {
  const params: string[] = []
  if (o.sort === 'top' && o.period)
    params.push(`period=${o.period}`)
  for (const t of o.tags ?? [])
    params.push(`${TAGS_PARAM}=${encodeURIComponent(t)}`)
  if ((o.tags?.length ?? 0) > 1)
    params.push('match_all_tags=true')
  if (o.page)
    params.push(`page=${o.page}`)
  return `${base}/${o.sort}.json${params.length ? `?${params.join('&')}` : ''}`
}

/** Whether a topic list answer has another page after it. */
export function listHasMore(data: any): boolean {
  return !!data?.topic_list?.more_topics_url && (data.topic_list.topics?.length ?? 0) > 0
}

const ORDER: Record<SearchOrder, string | null> = {
  relevance: null,
  // `latest` would order by the newest post, replies included.
  newest: 'latest_topic',
  likes: 'likes',
  views: 'views',
}

/**
 * What to search for, in the forum's own search syntax: the words, then the
 * filters. A creator's posts are the topics they started (`in:first`), not
 * every reply they wrote.
 */
export function searchQuery(o: { text?: string, tags?: readonly string[], creator?: string | null, order?: SearchOrder }): string {
  const parts = [o.text?.trim().replace(/\s+/g, ' ') ?? '']
  if (o.creator)
    parts.push(`@${o.creator}`, 'in:first')
  if (o.tags?.length)
    parts.push(`tags:${o.tags.join('+')}`)
  const order = ORDER[o.order ?? 'relevance']
  if (order)
    parts.push(`order:${order}`)
  return parts.filter(Boolean).join(' ')
}

/** A page of search results from the scripts categories. Pages count from 1. */
export function searchPath(q: string, page = 1): string {
  return `/search.json?q=${encodeURIComponent(q)}&category=scripts${page > 1 ? `&page=${page}` : ''}`
}

/** Whether a search answer has another page after it. */
export function searchHasMore(data: any): boolean {
  return !!data?.grouped_search_result?.more_full_page_results
}

/** The forum's tag search: every tag, not only the top ones a list carries. */
export function tagSearchPath(term: string, limit = 20): string {
  return `/tags/filter/search.json?q=${encodeURIComponent(term.trim())}&limit=${limit}`
}

/** Tags from a tag search answer. */
export function foundTags(data: any): ForumTag[] {
  return (Array.isArray(data?.results) ? data.results : [])
    .filter((r: any) => typeof r?.name === 'string' && r.name)
    .map((r: any) => ({ id: typeof r.id === 'number' ? r.id : -1, name: r.name, slug: r.slug || r.name }))
}

/**
 * Tags in the order to offer them for what was typed: the exact name, then
 * names starting with it, then a word in them starting with it, then the
 * rest (the forum ranks by use, and counts only public topics, so a script
 * tag can come last). Repeats and the tags already picked are left out.
 */
export function rankTags<T extends { name: string }>(tags: readonly T[], typed: string, exclude: readonly string[] = []): T[] {
  const q = typed.trim().toLowerCase()
  const skip = new Set(exclude.map(n => n.toLowerCase()))
  const seen = new Set<string>()
  const rank = (name: string) => (name === q ? 0 : name.startsWith(q) ? 1 : name.split(/[-_\s]/).some(w => w.startsWith(q)) ? 2 : 3)
  return tags
    .filter((t) => {
      const n = t.name.toLowerCase()
      if (skip.has(n) || seen.has(n))
        return false
      seen.add(n)
      return true
    })
    .map((t, i) => ({ t, i, r: rank(t.name.toLowerCase()) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(x => x.t)
}

interface Poster { description?: string, user_id?: number, user?: { username?: string } }

/**
 * Who started a topic: the poster marked Original Poster (the first one,
 * failing that). Topic lists name them by id, with the users alongside;
 * suggested topics carry the user inline.
 */
export function originalPoster(topic: { posters?: Poster[] | null }, users: readonly { id: number, username: string }[] = []): string | null {
  const posters = topic.posters ?? []
  const op = posters.find(p => /original poster/i.test(p.description ?? '')) ?? posters[0]
  if (!op)
    return null
  return op.user?.username ?? users.find(u => u.id === op.user_id)?.username ?? null
}

/** Who started each topic a search found. Only a hit on a topic's first post says; a reply's author may be anyone. */
export function searchStarters(posts: unknown): Map<number, string> {
  const out = new Map<number, string>()
  for (const p of Array.isArray(posts) ? posts : []) {
    if (p?.post_number === 1 && typeof p.username === 'string' && typeof p.topic_id === 'number')
      out.set(p.topic_id, p.username)
  }
  return out
}

/** Pages put together: a topic already listed is not listed again (the forum's lists move as people post). */
export function mergeById<T extends { id: number }>(have: readonly T[], more: readonly T[]): T[] {
  const ids = new Set(have.map(t => t.id))
  return [...have, ...more.filter(t => !ids.has(t.id) && ids.add(t.id))]
}

/** The topics the forum offers with a post: related ones first, then suggested ones; never the post itself, nor twice. */
export function similarTopics(data: any, selfId: number): any[] {
  const all = [...(Array.isArray(data?.related_topics) ? data.related_topics : []), ...(Array.isArray(data?.suggested_topics) ? data.suggested_topics : [])]
  return mergeById([], all.filter(t => typeof t?.id === 'number' && t.id !== selfId && t.title))
}

/** A forum bookmark, as the lists draw a topic. The forum does not say when the topic was posted, so that waits until it is opened. */
export interface BookmarkTopic {
  id: number
  slug: string
  title: string
  tags: string[]
  category_id: number
  created_at: string
  image_url: null
  views: null
  like_count: null
  creator: string | null
}

/**
 * The topics of a page of someone's forum bookmarks (`/u/<name>/bookmarks.json`),
 * one per topic, in the forum's order. A bookmark on a reply says who wrote
 * the reply, so the starter is only taken from one on the topic or its first post.
 */
export function bookmarkTopics(data: any): BookmarkTopic[] {
  const list = data?.user_bookmark_list?.bookmarks ?? data?.bookmarks
  const out: BookmarkTopic[] = []
  for (const b of Array.isArray(list) ? list : []) {
    const id = typeof b?.topic_id === 'number' ? b.topic_id : b?.bookmarkable_type === 'Topic' ? b.bookmarkable_id : null
    if (typeof id !== 'number' || !b.title)
      continue
    const firstPost = b.bookmarkable_type === 'Topic' || b.linked_post_number === 1
    out.push({
      id,
      slug: typeof b.slug === 'string' && b.slug ? b.slug : 'topic',
      title: String(b.title),
      tags: (Array.isArray(b.tags) ? b.tags : []).map((t: any) => (typeof t === 'string' ? t : t?.name)).filter(Boolean),
      category_id: typeof b.category_id === 'number' ? b.category_id : 0,
      created_at: '',
      image_url: null,
      views: null,
      like_count: null,
      creator: firstPost ? (b.user?.username ?? null) : null,
    })
  }
  return mergeById([], out)
}

/** Whether a topic was posted after `since` (ms). Never without a time to compare: a first visit has nothing new. */
export function isNewSince(createdAt: string | null | undefined, since: number | null): boolean {
  if (!since || !createdAt)
    return false
  const at = Date.parse(createdAt)
  return Number.isFinite(at) && at > since
}
