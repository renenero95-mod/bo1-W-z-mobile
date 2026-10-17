<script setup lang="ts">
import { onMounted, ref } from 'vue';
import Backdrop from './Backdrop.vue';
import CodeDialog from './CodeDialog.vue';
import MapPicker from './MapPicker.vue';
import OptionsDialog from './OptionsDialog.vue';
import RoomList from './RoomList.vue';
import { flag, read, setHell, startPicking, state, stopPicking, write, type Room } from './store.ts';

const NAME_KEY = 'bo1z-name';
const code = ref<InstanceType<typeof CodeDialog>>();
const options = ref<InstanceType<typeof OptionsDialog>>();
const pseudo = ref(read(NAME_KEY) ?? '');
let shown = '', invited = new URLSearchParams(location.search).get('room');

function setPseudo(input: HTMLInputElement) {
  pseudo.value = input.value.replace(/[^\w-]/g, '').slice(0, 15);
  input.value = pseudo.value;
  write(NAME_KEY, pseudo.value);
}

async function refresh() {
  try {
    const response = await fetch('/rooms', { cache: 'no-store' });
    if (response.ok) state.rooms = await response.json() as Room[];
  } catch {}
  const key = JSON.stringify(state.rooms);
  if (key !== shown) {
    shown = key;
    if (code.value!.isOpen()) code.value!.check();
  }
  if (invited !== null) {
    code.value!.open(invited);
    invited = null;
  }
  setTimeout(refresh, 2000);
}

onMounted(() => {
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && state.picking) stopPicking(); });
  refresh();
});
</script>

<template>
  <Backdrop />
  <div class="shade"></div>
  <div class="grain"></div>

  <div class="app">
    <header>
      <div class="logo">ZOMBIES<span>.</span><small>{{ $t('menu.tagline') }}</small></div>
      <div class="head-end">
        <div class="chip"><label for="pseudo">{{ $t('menu.name') }}</label><input id="pseudo" maxlength="15" placeholder="Unknown Soldier" autocomplete="nickname" :value="pseudo" @input="setPseudo($event.target as HTMLInputElement)"></div>
        <button class="ghost head-btn" id="open-options" type="button" @click="options!.open()">{{ $t('menu.options') }}</button>
      </div>
    </header>

    <div class="bar-top" role="tablist">
      <button class="tab" id="tab-solo" type="button" role="tab" :aria-selected="flag(state.tab === 'solo')" :hidden="state.picking" @click="state.tab = 'solo'">{{ $t('menu.solo') }}</button>
      <button class="tab" id="tab-multi" type="button" role="tab" :aria-selected="flag(state.tab === 'multi')" :hidden="state.picking" @click="state.tab = 'multi'">{{ $t('menu.multi') }}<em id="count">{{ state.rooms.length || '' }}</em></button>
      <div class="creating" id="creating" :hidden="!state.picking"><span class="tab" aria-selected="true">{{ $t('menu.creating') }}</span><small>{{ $t('menu.pickMap') }}</small></div>
      <div class="bar-end">
        <div class="views" id="views" role="group" :aria-label="$t('menu.view')" :hidden="state.tab !== 'solo'">
          <button type="button" data-view="grid" :aria-pressed="flag(state.view === 'grid')" :title="$t('menu.grid')" :aria-label="$t('menu.grid')" @click="state.view = 'grid'"><svg viewBox="0 0 18 18"><rect x="1" y="1" width="7" height="7"/><rect x="10" y="1" width="7" height="7"/><rect x="1" y="10" width="7" height="7"/><rect x="10" y="10" width="7" height="7"/></svg></button>
          <button type="button" data-view="list" :aria-pressed="flag(state.view === 'list')" :title="$t('menu.list')" :aria-label="$t('menu.list')" @click="state.view = 'list'"><svg viewBox="0 0 18 18"><rect x="1" y="2" width="16" height="3"/><rect x="1" y="7.5" width="16" height="3"/><rect x="1" y="13" width="16" height="3"/></svg></button>
        </div>
        <button class="switch" id="hell" type="button" role="switch" :aria-checked="flag(state.hell)" :hidden="state.tab !== 'solo' || state.picking" @click="setHell(!state.hell)"><i></i>{{ $t('hellMode') }}</button>
        <button class="ghost bar-btn" id="open-code" type="button" :hidden="state.tab !== 'multi'" @click="code!.open()">{{ $t('menu.joinCode') }}</button>
        <button class="ghost bar-btn" id="create" type="button" :hidden="state.tab !== 'multi'" @click="startPicking">{{ $t('menu.create') }}</button>
        <button class="switch" id="private" type="button" role="switch" :aria-checked="flag(state.hidden)" :hidden="!state.picking" @click="state.hidden = !state.hidden"><i></i>{{ $t('menu.private') }}</button>
        <button class="ghost bar-btn" id="cancel-pick" type="button" :hidden="!state.picking" @click="stopPicking">{{ $t('menu.cancel') }}</button>
      </div>
    </div>

    <section class="pane" id="pane-solo" :aria-label="$t('menu.maps')" :hidden="state.tab !== 'solo'"><MapPicker /></section>
    <section class="pane" id="pane-multi" :aria-label="$t('menu.rooms')" :hidden="state.tab !== 'multi'"><RoomList /></section>

    <footer>
      <span class="credits">{{ $t('menu.credits') }}</span>
    </footer>
  </div>

  <OptionsDialog ref="options" />
  <CodeDialog ref="code" />
</template>
