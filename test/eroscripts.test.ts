import { describe, expect, it } from 'vitest'
import { bookmarkTopics, isNewSince, listHasMore, mergeById, originalPoster, rankTags, searchHasMore, searchPath, searchQuery, searchStarters, similarTopics, topicListPath } from '~/lib/eroscripts'

const BASE = '/c/scripts/free-scripts/14/l'

describe('topicListPath', () => {
  it('asks for a plain list as before', () => {
    expect(topicListPath(BASE, { sort: 'latest' })).toBe(`${BASE}/latest.json`)
    expect(topicListPath(BASE, { sort: 'hot', page: 2 })).toBe(`${BASE}/hot.json?page=2`)
  })

  it('filters by any number of tags, all of which must match', () => {
    expect(topicListPath(BASE, { sort: 'latest', tags: ['vr'] })).toBe(`${BASE}/latest.json?tags%5B%5D=vr`)
    expect(topicListPath(BASE, { sort: 'latest', tags: ['vr', 'pov'], page: 1 }))
      .toBe(`${BASE}/latest.json?tags%5B%5D=vr&tags%5B%5D=pov&match_all_tags=true&page=1`)
  })

  it('gives Top its period, and only Top', () => {
    expect(topicListPath(BASE, { sort: 'top', period: 'weekly', tags: ['vr'] })).toBe(`${BASE}/top.json?period=weekly&tags%5B%5D=vr`)
    expect(topicListPath(BASE, { sort: 'latest', period: 'weekly' })).toBe(`${BASE}/latest.json`)
  })
})

describe('searchQuery', () => {
  it('adds tags and the order to the words', () => {
    expect(searchQuery({ text: '  dua  lipa ', tags: ['pmv', 'vr'], order: 'newest' })).toBe('dua lipa tags:pmv+vr order:latest_topic')
    expect(searchQuery({ text: 'x', order: 'relevance' })).toBe('x')
    expect(searchQuery({ text: 'x', order: 'likes' })).toBe('x order:likes')
    expect(searchQuery({ text: 'x', order: 'views' })).toBe('x order:views')
  })

  it('finds the topics a creator started', () => {
    expect(searchQuery({ creator: 'Wutboi', order: 'newest' })).toBe('@Wutboi in:first order:latest_topic')
  })
})

describe('paging', () => {
  it('pages search from 1 in the scripts categories', () => {
    expect(searchPath('a b')).toBe('/search.json?q=a%20b&category=scripts')
    expect(searchPath('a', 3)).toBe('/search.json?q=a&category=scripts&page=3')
  })

  it('reads whether there is more', () => {
    expect(searchHasMore({ grouped_search_result: { more_full_page_results: true } })).toBe(true)
    expect(searchHasMore({ grouped_search_result: { more_full_page_results: null } })).toBe(false)
    expect(listHasMore({ topic_list: { more_topics_url: '/c/x/l/latest?page=1', topics: [{}] } })).toBe(true)
    expect(listHasMore({ topic_list: { topics: [{}] } })).toBe(false)
  })

  it('does not list a topic twice when the pages shift', () => {
    expect(mergeById([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 3 }, { id: 3 }]).map(t => t.id)).toEqual([1, 2, 3])
  })
})

describe('creators', () => {
  it('takes the original poster from a topic list, or inline from suggestions', () => {
    const users = [{ id: 7, username: 'Wutboi' }, { id: 9, username: 'Replier' }]
    expect(originalPoster({ posters: [{ description: 'Frequent Poster', user_id: 9 }, { description: 'Original Poster, Most Recent Poster', user_id: 7 }] }, users)).toBe('Wutboi')
    expect(originalPoster({ posters: [{ description: 'Original Poster', user: { username: 'Inline' } }] })).toBe('Inline')
    expect(originalPoster({ posters: [] }, users)).toBeNull()
  })

  it('only trusts a search hit on the first post', () => {
    const map = searchStarters([{ topic_id: 1, post_number: 1, username: 'Op' }, { topic_id: 2, post_number: 5, username: 'Replier' }])
    expect([...map]).toEqual([[1, 'Op']])
  })
})

describe('rankTags', () => {
  it('puts the exact tag and prefixes first, without the picked ones', () => {
    const tags = ['futanari', 'anal', 'double-anal', 'anal-creampie', 'banana', 'anal'].map(name => ({ name }))
    expect(rankTags(tags, 'Anal', []).map(t => t.name)).toEqual(['anal', 'anal-creampie', 'double-anal', 'futanari', 'banana'])
    expect(rankTags(tags, 'anal', ['anal']).map(t => t.name)).toEqual(['anal-creampie', 'double-anal', 'futanari', 'banana'])
  })
})

describe('similarTopics', () => {
  it('lists related, then suggested, never the post itself', () => {
    const data = { related_topics: [{ id: 2, title: 'b' }], suggested_topics: [{ id: 1, title: 'self' }, { id: 2, title: 'b' }, { id: 3, title: 'c' }] }
    expect(similarTopics(data, 1).map(t => t.id)).toEqual([2, 3])
    expect(similarTopics({}, 1)).toEqual([])
  })
})

describe('bookmarkTopics', () => {
  it('turns bookmarks into topics, once each, with the starter only when known', () => {
    const data = {
      user_bookmark_list: {
        bookmarks: [
          { topic_id: 5, slug: 'five', title: 'Five', tags: ['vr'], category_id: 14, bookmarkable_type: 'Post', linked_post_number: 1, user: { username: 'Op' } },
          { topic_id: 6, slug: 'six', title: 'Six', bookmarkable_type: 'Post', linked_post_number: 4, user: { username: 'Replier' } },
          { topic_id: 5, slug: 'five', title: 'Five', bookmarkable_type: 'Topic', user: { username: 'Op' } },
        ],
      },
    }
    const out = bookmarkTopics(data)
    expect(out.map(t => [t.id, t.creator])).toEqual([[5, 'Op'], [6, null]])
    expect(out[0]).toMatchObject({ slug: 'five', tags: ['vr'], category_id: 14 })
    expect(bookmarkTopics({ bookmarks: [] })).toEqual([])
  })
})

describe('isNewSince', () => {
  it('marks topics posted after the last visit, and none on the first', () => {
    const since = Date.parse('2026-11-20T00:00:00Z')
    expect(isNewSince('2026-11-21T10:00:00Z', since)).toBe(true)
    expect(isNewSince('2026-11-19T10:00:00Z', since)).toBe(false)
    expect(isNewSince('2026-11-21T10:00:00Z', null)).toBe(false)
    expect(isNewSince('', since)).toBe(false)
  })
})
