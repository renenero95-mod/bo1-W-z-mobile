<script setup lang="ts">
import { bySlug, HOST, hover, isFull, join, panel, state, unhover, type Room } from './store.ts';

const hostFirst = (room: Room) => [...room.members].sort((a, b) => Number(b.label === HOST) - Number(a.label === HOST));
</script>

<template>
  <div id="rooms">
    <div v-if="!state.rooms.length" class="none"><b>{{ $t('rooms.none') }}</b><span>{{ $t('rooms.noneHint') }}</span></div>
    <div v-else class="rlist">
      <div class="head"><span></span><span>{{ $t('rooms.lobby') }}</span><span>{{ $t('rooms.map') }}</span><span>{{ $t('rooms.players') }}</span><span>{{ $t('rooms.slots') }}</span><span></span></div>
      <div v-for="room in state.rooms" :key="room.name" :class="['line', { full: isFull(room) }]"
        @mouseenter="bySlug(room.map) && hover(bySlug(room.map)!)" @mouseleave="bySlug(room.map) && unhover()">
        <div class="thumb" :style="bySlug(room.map) ? { backgroundImage: `url(${panel(bySlug(room.map)!)})` } : {}"></div>
        <b>{{ room.name }}</b>
        <span class="cell">{{ bySlug(room.map) ? $t(`maps.${room.map}.name`) : room.map }}</span>
        <div class="party"><span v-for="member in hostFirst(room)" :key="member.label" :title="member.label === HOST ? $t('host') : undefined">{{ member.pseudo || 'Unknown Soldier' }}</span></div>
        <span class="count">{{ room.players }} / 4</span>
        <button type="button" :class="isFull(room) ? 'ghost' : 'ghost join'" :disabled="isFull(room)" @click="join(room)">{{ isFull(room) ? $t('rooms.full') : $t('rooms.join') }}</button>
      </div>
    </div>
  </div>
</template>
