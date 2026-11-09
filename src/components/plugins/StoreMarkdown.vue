<script setup lang="ts">
import type { VNode } from 'vue'
import type { Block, Inline } from '~/lib/markdown'
import { computed, h } from 'vue'
import { githubMarkdown, parseMarkdown } from '~/lib/markdown'

/**
 * Markdown from a plugin (its README, long description or release notes),
 * built element by element from lib/markdown's tree: no HTML from the text
 * reaches the page. Links open in the system browser; images load only from
 * GitHub. `dropTitle` leaves out a leading # heading (a README's title is
 * the plugin's name, already shown).
 */
const props = defineProps<{ source: string, repo: string | null, dropTitle?: boolean }>()

const tree = computed(() => {
  const b = parseMarkdown(props.source, githubMarkdown(props.repo))
  return props.dropTitle && b[0]?.t === 'h' && b[0].level === 1 ? b.slice(1) : b
})

function inline(nodes: Inline[]): (VNode | string)[] {
  return nodes.map((n) => {
    switch (n.t) {
      case 'text': return n.v
      case 'code': return h('code', n.v)
      case 'strong': return h('strong', inline(n.c))
      case 'em': return h('em', inline(n.c))
      case 'del': return h('del', inline(n.c))
      case 'br': return h('br')
      case 'link': return h('a', { href: n.href, target: '_blank', rel: 'noopener noreferrer nofollow' }, inline(n.c))
      case 'img': return h('img', { src: n.src, alt: n.alt, loading: 'lazy', referrerpolicy: 'no-referrer', decoding: 'async' })
    }
    return ''
  })
}

function block(b: Block, key: number): VNode {
  switch (b.t) {
    // Headings sit under the view's own: # reads as a section title, not a page title.
    case 'h': return h(`h${Math.min(6, b.level + 2)}`, { key }, inline(b.c))
    case 'p': return h('p', { key }, inline(b.c))
    case 'code': return h('pre', { key }, [h('code', b.v)])
    case 'quote': return h('blockquote', { key }, b.c.map(block))
    case 'hr': return h('hr', { key })
    case 'list': return h(b.ordered ? 'ol' : 'ul', { key, start: b.ordered && b.start !== 1 ? b.start : undefined }, b.items.map((it, k) => {
      // A list item of one paragraph is just its text.
      const only = it.length === 1 && it[0].t === 'p' ? inline(it[0].c) : it.map(block)
      return h('li', { key: k }, only)
    }))
    case 'table': return h('div', { key, class: 'md-table' }, [h('table', [
      h('thead', [h('tr', b.head.map((c, k) => h('th', { key: k, style: b.align[k] ? { textAlign: b.align[k] } : undefined }, inline(c))))]),
      h('tbody', b.rows.map((r, ri) => h('tr', { key: ri }, r.map((c, k) => h('td', { key: k, style: b.align[k] ? { textAlign: b.align[k] } : undefined }, inline(c)))))),
    ])])
  }
}

const Rendered = () => tree.value.map(block)
</script>

<template>
  <div class="md">
    <Rendered />
  </div>
</template>

<style scoped>
.md {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-muted);
  overflow-wrap: anywhere;
}
.md > :deep(*:first-child) {
  margin-top: 0;
}
.md > :deep(*:last-child) {
  margin-bottom: 0;
}
.md :deep(p),
.md :deep(ul),
.md :deep(ol),
.md :deep(pre),
.md :deep(blockquote),
.md :deep(.md-table) {
  margin: 0 0 0.7em;
}
.md :deep(h3),
.md :deep(h4),
.md :deep(h5),
.md :deep(h6) {
  color: var(--text);
  font-weight: 600;
  line-height: 1.3;
  margin: 1.2em 0 0.45em;
}
.md :deep(h3) {
  font-size: 14px;
}
.md :deep(h4) {
  font-size: 13px;
}
.md :deep(h5),
.md :deep(h6) {
  font-size: 12.5px;
}
.md :deep(strong) {
  color: var(--text);
  font-weight: 600;
}
.md :deep(a) {
  color: var(--accent-light);
  text-decoration: underline;
  text-decoration-color: color-mix(in oklab, var(--accent-light) 40%, transparent);
  text-underline-offset: 2px;
}
.md :deep(a:hover) {
  text-decoration-color: currentColor;
}
.md :deep(ul),
.md :deep(ol) {
  padding-left: 1.3em;
}
.md :deep(ul) {
  list-style: disc;
}
.md :deep(ol) {
  list-style: decimal;
}
.md :deep(li) {
  margin: 0.2em 0;
}
.md :deep(li > p) {
  margin: 0.2em 0;
}
.md :deep(li::marker) {
  color: var(--text-faint);
}
.md :deep(code) {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.92em;
  padding: 0.1em 0.35em;
  border-radius: 4px;
  background: var(--bg-800);
  color: var(--text);
}
.md :deep(pre) {
  padding: 0.7em 0.9em;
  border-radius: var(--radius-md);
  background: var(--bg-800);
  overflow-x: auto;
  line-height: 1.5;
}
.md :deep(pre code) {
  padding: 0;
  background: none;
  white-space: pre;
}
.md :deep(blockquote) {
  padding-left: 0.9em;
  border-left: 2px solid var(--border-strong);
}
.md :deep(hr) {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 1em 0;
}
.md :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: var(--radius-sm);
  vertical-align: middle;
}
.md :deep(.md-table) {
  overflow-x: auto;
}
.md :deep(table) {
  border-collapse: collapse;
  font-size: 12px;
}
.md :deep(th),
.md :deep(td) {
  border: 1px solid var(--border);
  padding: 0.35em 0.6em;
  vertical-align: top;
}
.md :deep(th) {
  text-align: left;
  color: var(--text);
  font-weight: 600;
  background: var(--bg-800);
}
</style>
