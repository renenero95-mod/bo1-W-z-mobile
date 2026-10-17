<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { MAPS } from '../catalog.ts';
import { art, state, type GameMap } from './store.ts';

const layers = ref<(GameMap | null)[]>([null, null]);
const front = ref(0);

function show(map: GameMap) {
  if (layers.value[front.value]?.zone === map.zone) return;
  front.value ^= 1;
  layers.value[front.value] = map;
}

function rotate() {
  if (state.hovering) return;
  const others = MAPS.filter(map => map.zone !== layers.value[front.value]?.zone);
  show(others[Math.floor(Math.random() * others.length)]);
}

watch(() => state.backdrop, map => map && show(map));
let timer = 0;
onMounted(() => { rotate(); timer = setInterval(rotate, 6000); });
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="bg">
    <div v-for="(map, k) in layers" :key="k" :class="{ on: k === front }" :style="map ? { backgroundImage: `url(${art(map)})` } : {}"></div>
  </div>
</template>
