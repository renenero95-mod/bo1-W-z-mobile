<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { hordeCount, hordeRound } from '../game/horde.ts';
import { LANGS, setLang } from '../i18n/index.ts';
import { loadSettings, saveSettings as save } from '../game/settings.ts';
import { flag } from './store.ts';

const saved = loadSettings();
const { locale, n } = useI18n();
const dialog = ref<HTMLDialogElement>();
const sensitivity = ref(saved.sensitivity);
const volume = ref(saved.volume);
const fullscreen = ref(saved.fullscreen);
const count = ref(saved.horde.n);
const round = ref(saved.horde.round);

function setSensitivity(value: string) { sensitivity.value = Number(value); save({ sensitivity: sensitivity.value }); }
function setVolume(value: string) { volume.value = Number(value); save({ volume: volume.value, volumeChosen: true }); }
function toggleFullscreen() { fullscreen.value = !fullscreen.value; save({ fullscreen: fullscreen.value }); }
function setHorde(input: HTMLInputElement, n: string, r: string) {
  count.value = hordeCount(n);
  round.value = hordeRound(r);
  input.value = String(input.id === 'o-n' ? count.value : round.value);
  save({ horde: { n: count.value, round: round.value } });
}

defineExpose({ open: () => { dialog.value!.showModal(); dialog.value!.focus(); } });
</script>

<template>
  <dialog ref="dialog" class="joincode options" id="options" tabindex="-1">
    <form method="dialog">
      <h2>{{ $t('options.title') }}</h2>
      <div class="opts">
        <div class="opt-group">{{ $t('options.language') }}</div>
        <div class="opt">{{ $t('options.languageRow') }}<div class="lang" id="o-lang" role="radiogroup" :aria-label="$t('options.language')"><button v-for="(label, code) in LANGS" :key="code" type="button" role="radio" :lang="code" :aria-checked="flag(locale === code)" @click="setLang(code)">{{ label }}</button></div></div>
        <div class="opt-group">{{ $t('options.controls') }}</div>
        <label class="opt">{{ $t('options.sensitivity') }}<input type="range" id="o-sens" min="0.5" max="15" step="0.5" :value="sensitivity" @input="setSensitivity(($event.target as HTMLInputElement).value)"><output id="o-sens-v">{{ n(sensitivity, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }}</output></label>
        <div class="opt-group">{{ $t('options.sound') }}</div>
        <label class="opt">{{ $t('options.volume') }}<input type="range" id="o-vol" min="0" max="1" step="0.05" :value="volume" @input="setVolume(($event.target as HTMLInputElement).value)"><output id="o-vol-v">{{ n(volume, { style: 'percent' }) }}</output></label>
        <div class="opt-group">{{ $t('options.display') }}</div>
        <div class="opt">{{ $t('options.fullscreen') }}<button class="switch" id="o-full" type="button" role="switch" :aria-checked="flag(fullscreen)" @click="toggleFullscreen"><i></i></button></div>
        <div class="opt-group">{{ $t('hellMode') }}</div>
        <label class="opt">{{ $t('options.zombies') }}<input type="number" id="o-n" min="24" max="300" :value="count" @change="setHorde($event.target as HTMLInputElement, ($event.target as HTMLInputElement).value, String(round))"></label>
        <label class="opt">{{ $t('options.round') }}<input type="number" id="o-round" min="1" max="255" :value="round" @change="setHorde($event.target as HTMLInputElement, String(count), ($event.target as HTMLInputElement).value)"></label>
      </div>
      <div class="actions"><button class="ghost" type="submit">{{ $t('options.back') }}</button></div>
    </form>
  </dialog>
</template>
