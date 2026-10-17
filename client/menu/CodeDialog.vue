<script setup lang="ts">
import { ref } from 'vue';
import { isFull, join, lookup, state, type Room } from './store.ts';

const dialog = ref<HTMLDialogElement>();
const boxes = ref<HTMLInputElement[]>([]);
const letters = ref(['', '', '', '']);
const note = ref<'' | 'missing' | 'full'>('');
const disabled = ref(true);
let typed = '';

// A private room is not in the list: the code is checked with the server, and only the latest input counts.
async function check(): Promise<Room | null | undefined> {
  const value = letters.value.join('');
  typed = value;
  disabled.value = true;
  if (value.length < 4) return void (note.value = '');
  const room = await lookup(value);
  if (typed !== value) return null;
  disabled.value = !room || isFull(room);
  note.value = !room ? 'missing' : isFull(room) ? 'full' : '';
  return room;
}

function fill(from: number, text: string) {
  const found = text.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4 - from);
  [...found].forEach((letter, k) => { letters.value[from + k] = letter; });
  boxes.value[Math.min(from + found.length, 3)].focus();
  check();
}

function clear(k: number) {
  letters.value[k] = '';
  check();
}

function key(event: KeyboardEvent, k: number) {
  if (event.metaKey || event.ctrlKey || event.altKey || event.key === 'Tab') return;
  event.preventDefault();
  if (/^[a-z]$/i.test(event.key)) fill(k, event.key);
  else if (event.key === 'Backspace' && !letters.value[k] && k > 0) { boxes.value[k - 1].focus(); clear(k - 1); }
  else if (event.key === 'Backspace' || event.key === 'Delete') clear(k);
  else if (event.key === 'ArrowLeft' && k > 0) boxes.value[k - 1].focus();
  else if (event.key === 'ArrowRight' && k < 3) boxes.value[k + 1].focus();
  else if (event.key === 'Enter') submit();
  else if (event.key === 'Escape') dialog.value!.close();
}

async function submit() {
  const room = await check();
  if (!room || isFull(room)) return;
  dialog.value!.close();
  join(room);
}

function open(text = '') {
  state.tab = 'multi';
  letters.value = ['', '', '', ''];
  dialog.value!.showModal();
  fill(0, text);
}

defineExpose({ open, check, isOpen: () => Boolean(dialog.value?.open) });
</script>

<template>
  <dialog ref="dialog" class="joincode" id="joincode">
    <form method="dialog">
      <h2>{{ $t('code.title') }}</h2>
      <p class="or">{{ $t('code.hint') }}</p>
      <div class="code" role="group" :aria-label="$t('code.label')">
        <input v-for="k in 4" :key="k" ref="boxes" :value="letters[k - 1]" autocomplete="off" spellcheck="false" :aria-label="$t('code.letter', { n: k })"
          @keydown="key($event, k - 1)" @paste.prevent="fill(k - 1, $event.clipboardData?.getData('text') ?? '')" @input="fill(k - 1, ($event.target as HTMLInputElement).value)">
      </div>
      <p class="code-note" id="code-note">{{ note && $t(`code.${note}`) }}</p>
      <div class="actions"><button class="ghost join" id="join-code" type="button" :disabled="disabled" @click="submit">{{ $t('code.join') }}</button><button class="ghost" type="submit">{{ $t('code.back') }}</button></div>
    </form>
  </dialog>
</template>
