<script setup lang="ts">
import type { InsightReport } from '~/lib/insights'
import { computed } from 'vue'
import UiBadge from '~/components/ui/UiBadge.vue'

/**
 * The Insights section of Stats: findings from lib/insights, each with what
 * it is based on, and a short list of what will show once there is more.
 */
const props = defineProps<{ report: InsightReport }>()

const since = computed(() => new Date(props.report.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }))
const anyNewOnly = computed(() => props.report.insights.some(i => i.newOnly) || props.report.pending.some(p => p.newOnly))
</script>

<template>
  <section class="flex flex-col gap-3" aria-labelledby="insights-title">
    <div class="flex flex-wrap gap-x-3 gap-y-1 items-baseline">
      <h2 id="insights-title" class="text-[14px] text-fg font-semibold">
        Insights
      </h2>
      <p class="hint">
        What your history adds up to. Each one says how much it rests on.
      </p>
    </div>

    <div v-if="report.insights.length" class="gap-3 grid lg:grid-cols-2">
      <article v-for="i in report.insights" :key="i.id" class="p-4 card flex flex-col gap-2.5">
        <header class="flex gap-2.5 items-center">
          <span class="text-[15px] text-accent-300 rounded-[var(--radius-sm)] bg-accent-soft center shrink-0 h-7 w-7">
            <span :class="i.icon" />
          </span>
          <h3 class="text-[13px] text-fg font-semibold flex-1 min-w-0 truncate">
            {{ i.title }}
          </h3>
          <UiBadge v-if="i.newOnly" size="xs" tone="neutral">
            since {{ since }}
          </UiBadge>
        </header>
        <p class="text-[13px] text-fg leading-relaxed">
          {{ i.text }}
        </p>
        <p v-if="i.more" class="text-[12.5px] text-fg-muted leading-relaxed">
          {{ i.more }}
        </p>
        <ul v-if="i.bars?.length" class="flex flex-col gap-1.5" :aria-label="i.title">
          <li v-for="b in i.bars" :key="b.label" class="flex gap-3 items-center">
            <span v-tip="b.label.length > 14 ? b.label : undefined" class="text-[12px] shrink-0 w-24 truncate" :class="b.highlight ? 'text-fg font-medium' : 'text-fg-muted'">{{ b.label }}</span>
            <div class="rounded-full bg-fg/6 flex-1 h-1.5 overflow-hidden">
              <div
                class="rounded-full h-full transition-[width] duration-500 ease-[var(--ease-out)]"
                :class="b.highlight ? 'bg-accent' : 'bg-accent/45'"
                :style="{ width: `${Math.max(b.value > 0 ? 2 : 0, b.value * 100)}%` }"
              />
            </div>
            <span class="text-[12px] num text-right shrink-0 w-20" :class="b.highlight ? 'text-fg' : 'text-fg-muted'">{{ b.display }}</span>
            <span v-if="i.bars.some(x => x.sub)" class="text-[11px] text-fg-faint text-right shrink-0 w-24 hidden whitespace-nowrap sm:inline">{{ b.sub }}</span>
          </li>
        </ul>
        <p class="hint">
          {{ i.note }}
        </p>
      </article>
    </div>

    <div v-if="report.pending.length" class="px-4 py-3 well flex flex-col gap-2">
      <p class="text-[12.5px] text-fg-muted font-medium">
        {{ report.insights.length ? 'More once there is more to go on' : 'Nothing to say yet: it needs a little more history' }}
      </p>
      <ul class="gap-x-6 gap-y-1 grid sm:grid-cols-2">
        <li v-for="p in report.pending" :key="p.id" class="text-[12px] flex gap-2 min-w-0 items-baseline">
          <span class="text-fg-muted shrink-0">{{ p.title }}:</span>
          <span class="text-fg-faint">{{ p.need }}</span>
        </li>
      </ul>
    </div>

    <p v-if="anyNewOnly" class="hint">
      Sessions are logged from {{ since }}: when each starts and ends, its edges and finishes, and the heart rate and script pace at those
      moments. Findings marked "since {{ since }}" only cover those; the rest use everything recorded.
      A session ends after half an hour with nothing playing.
    </p>
  </section>
</template>
