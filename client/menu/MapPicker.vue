<script setup lang="ts">
import { computed } from 'vue';
import { MAPS } from '../catalog.ts';
import { ERA, hover, off, panel, pick, select, state, unhover, type GameMap } from './store.ts';

const eras = Object.keys(ERA);
const byEra = (era: string) => MAPS.filter(map => map.era === era);
const number = (map: GameMap) => String(MAPS.indexOf(map) + 1).padStart(2, '0');
const described = computed(() => state.selected);
const describe = (map: GameMap) => { hover(map); state.selected = map; };
</script>

<template>
  <div id="maps">
    <template v-if="state.view === 'grid'">
      <template v-for="era in eras" :key="era">
        <h3 :class="['era-title', ERA[era]]">{{ era }}</h3>
        <div class="grid">
          <button v-for="map in byEra(era)" :key="map.slug" type="button" :class="['mapc', ERA[map.era], { off: off(map) }]" :aria-disabled="off(map) ? 'true' : undefined"
            :style="{ backgroundImage: `url(${panel(map)})` }" @mouseenter="describe(map)" @focus="describe(map)" @mouseleave="unhover" @blur="unhover" @click="pick(map)">
            <div><b>{{ $t(`maps.${map.slug}.name`) }}</b><span>{{ map.horde && !state.picking ? $t('hellMode') : '' }}</span></div>
          </button>
        </div>
      </template>
    </template>
    <div v-else class="solo-list">
      <div class="maps">
        <template v-for="era in eras" :key="era">
          <h3 :class="['era-title', ERA[era]]">{{ era }}</h3>
          <button v-for="map in byEra(era)" :key="map.slug" type="button" :class="['row', ERA[era], { off: off(map), sel: state.selected === map }]" :data-slug="map.slug"
            :aria-disabled="off(map) ? 'true' : undefined" @mouseenter="select(map)" @focus="select(map)" @mouseleave="unhover" @blur="unhover" @click="pick(map)">{{ $t(`maps.${map.slug}.name`) }}</button>
        </template>
      </div>
      <div :class="['detail', { on: described }]">
        <div class="shot" role="img" :aria-label="described ? $t('menu.preview', { map: $t(`maps.${described.slug}.name`) }) : undefined" :style="described ? { backgroundImage: `url(${panel(described)})` } : {}"></div>
        <div :class="['kicker', described && ERA[described.era]]">{{ described ? $t('menu.number', { era: described.era, n: number(described) }) : '' }}</div>
        <h2>{{ described && $t(`maps.${described.slug}.name`) }}</h2>
        <div class="place">{{ described && $t(`maps.${described.slug}.place`) }}</div>
        <p class="desc">{{ described && $t(`maps.${described.slug}.desc`) }}</p>
      </div>
    </div>
  </div>
  <p class="describe" id="describe" :hidden="state.view === 'list'"><template v-if="described"><b>{{ $t(`maps.${described.slug}.name`) }}</b><span>{{ $t(`maps.${described.slug}.desc`) }}</span></template></p>
</template>
