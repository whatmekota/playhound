<script setup lang="ts">
import PluginOverlay from '~/components/plugins/PluginOverlay.vue'
import { usePluginStore } from '~/stores/pluginStore'

/** Every switched-on plugin's layer over the video, in the order the plugins are listed (later ones on top). */
const store = usePluginStore()

// A plugin that sets a new layer gets it mounted afresh, not the old one's element with new props.
const keys = new WeakMap<object, number>()
let seq = 0
function keyOf(o: object): number {
  let k = keys.get(o)
  if (k === undefined) {
    k = ++seq
    keys.set(o, k)
  }
  return k
}
</script>

<template>
  <PluginOverlay
    v-for="p in store.overlays"
    :key="keyOf(p.overlay!)"
    :overlay="p.overlay!"
    :plugin-id="p.manifest.id"
  />
</template>
