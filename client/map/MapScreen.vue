<script setup lang="ts">
import { defineAsyncComponent, onMounted, onUnmounted, ref, useTemplateRef } from 'vue';
import { map } from '../game/pack.ts';
import { startSession, view } from '../game/session.ts';
import Loading from './Loading.vue';

const Perf = defineAsyncComponent(() => import('./Perf.vue'));
const perf = ref<'off' | 'compact' | 'detail'>('off');
const game = useTemplateRef<HTMLCanvasElement>('game');

// F3, caught on window before the game's keys and Chrome's find-next: compact, detailed, hidden.
function cycle(event: KeyboardEvent) {
  if (event.key !== 'F3' || event.repeat) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  perf.value = perf.value === 'off' ? 'compact' : perf.value === 'compact' ? 'detail' : 'off';
}
addEventListener('keydown', cycle, true);
onUnmounted(() => removeEventListener('keydown', cycle, true));
onMounted(() => startSession(game.value!));
</script>

<template>
  <canvas id="game" ref="game" width="1280" height="720" tabindex="0" :aria-label="$t(`maps.${map.slug}.name`)"></canvas>
  <Loading />
  <p class="kb-resume" v-if="view.screen === 'playing' && view.resume">{{ $t('game.resume') }}</p>
  <Perf v-if="perf !== 'off'" :mode="perf" />
</template>
