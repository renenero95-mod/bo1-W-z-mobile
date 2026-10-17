<script setup lang="ts">
import { computed, onUnmounted, ref, shallowReactive, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import { BASE, hiddenRoom, horde, map, room } from '../game/pack.ts';
import { enter, type Failure, retry, view } from '../game/session.ts';
import { HOST } from '../net/lan.ts';
import { link, role } from '../net/link.ts';

type Problem = { title: string; text: string; hint?: string; primary?: [string, () => void]; report?: boolean };

const { t, n, tm } = useI18n();
const PARTS = ['shaders', 'sounds', 'textures', 'music', 'map', 'engine'];
const name = computed(() => t(`maps.${map.slug}.name`));
const kicker = computed(() => (room ? t(hiddenRoom ? 'privateRoom' : 'room', { code: room }) : horde ? `${t('load.solo')} · ${t('hellMode')}` : t('load.solo')));
const reload = (label = t('errors.reload')): [string, () => void] => [label, () => location.reload()];
const texts = (key: string, params: Record<string, unknown> = {}) => ({ title: t(`errors.${key}.title`, params), text: t(`errors.${key}.text`, params), hint: t(`errors.${key}.hint`, params) });

const ui = shallowReactive({ tip: 0, copy: 'copy' as 'copy' | 'copied' | 'copyKeys' });
// Kept once the host leaves, for the message that says so.
const hostName = ref('');
watchEffect(() => {
  const pseudo = link.members.find(member => member.label === HOST)?.pseudo;
  if (pseudo) hostName.value = pseudo;
});
const host = computed(() => hostName.value || t('load.theHost'));
const details = ref<HTMLDetailsElement>();
const pre = ref<HTMLPreElement>();

const TIPS = tm('load.tips').length;
let tip = Math.floor(Math.random() * TIPS);
const showTip = () => { ui.tip = tip++ % TIPS; };
showTip();
const tips = setInterval(showTip, 8000);

const size = (bytes: number) => (bytes < 1e9 ? n(Math.ceil(bytes / 1e6), { style: 'unit', unit: 'megabyte' })
  : n(bytes / 1e9, { style: 'unit', unit: 'gigabyte', minimumFractionDigits: 1, maximumFractionDigits: 1 }));

function failureProblem(failure: Failure): Problem {
  const map = name.value;
  switch (failure.kind) {
    case 'download':
      if (failure.files) return { ...texts('files'), primary: [t('errors.resume'), retry] };
      return { ...texts('download', { pct: n(view.pct / 100, { style: 'percent' }), map }), ...(!view.pct && { text: t('errors.download.textAnyTime', { map }) }),
        primary: [t('errors.resume'), retry] };
    case 'quota':
      return { ...texts('quota', { map, size: failure.missingBytes ? size(failure.missingBytes) : '' }),
        ...(!failure.missingBytes && { text: t('errors.quota.textUnknown', { map }) }), primary: [t('errors.retry'), retry] };
    case 'storage':
      return { ...texts('storage'), primary: reload() };
    case 'browser': case 'mobile': case 'gpu':
      return texts('browser') + (typeof window !== 'undefined' && new URLSearchParams(location.search).has('debug') ? ' [DEBUG MODE — checks bypassati]' : '');
    case 'secure':
      return texts('secure');
    case 'engine':
      return { ...texts(failure.memory ? 'memory' : 'crash', { map }), primary: reload(), report: true };
  }
}

const problem = computed<Problem | null>(() => {
  if (link.failure === 'signal') return { ...texts('signal'), primary: reload(t('errors.retry')) };
  if (link.failure === 'host-left') return texts('hostLeft', { host: host.value, room });
  if (link.failure === 'unreachable') return { ...texts('unreachable', { host: host.value }), primary: reload(t('errors.retry')) };
  return view.screen === 'error' && view.failure ? failureProblem(view.failure) : null;
});
const guest = computed(() => role() === 'guest');
const party = computed(() => link.members.map(({ label, pseudo }) => ({ label, pseudo, me: label === link.label, dot: label === HOST && guest.value })));
const gone = computed(() => !problem.value && view.screen === 'playing');
const full = computed(() => view.screen === 'ready' || view.screen === 'playing');
const parts = computed(() => !Object.keys(view.groups).length ? [] : PARTS.filter(key => key === 'engine' || view.groups[key]).map(key => {
  const [done, size] = view.groups[key] ?? [0, 1];
  return { key, pct: full.value ? 100 : Math.floor(100 * (key === 'engine' ? view.engine : done / size)) };
}));
const status = computed(() => t(full.value ? 'load.ready' : view.screen === 'loading' ? 'load.engine' : 'load.downloading'));
const eta = computed(() => {
  if (full.value || view.eta === null) return '';
  if (view.eta < 8) return t('load.almostDone');
  return view.eta < 60 ? t('load.seconds', { n: Math.max(5, Math.round(view.eta / 5) * 5) }) : t('load.minutes', { n: Math.round(view.eta / 60) });
});
const dot = computed(() => (link.relayed ? 'relay' : link.linked ? 'ok' : 'wait'));

async function copy() {
  try {
    await navigator.clipboard.writeText(view.report);
    ui.copy = 'copied';
  } catch {
    details.value!.open = true;
    getSelection()?.selectAllChildren(pre.value!);
    ui.copy = 'copyKeys';
  }
}

function click(event: MouseEvent) {
  if (!(event.target as Element).closest('a, button, details')) enter();
}

onUnmounted(() => clearInterval(tips));
</script>

<template>
  <section :class="['kb-loading', { 'kb-gone': gone, 'kb-failed': problem }]" aria-live="polite" @click="click">
    <div class="kb-art" :style="{ backgroundImage: `url(art/loadscreen_${map.zone}.webp)` }"></div><div class="kb-veil"></div>
    <a class="kb-back" :href="BASE">{{ $t('load.cancel') }}</a>
    <div class="kb-box">
      <div class="kb-kicker">{{ kicker }}</div><h2 class="kb-name">{{ name }}</h2>
      <div class="kb-party" :hidden="!room">
        <span v-for="member in party" :key="member.label" :class="member.me ? 'me' : ''" :title="member.label === HOST ? $t('host') : undefined"><i v-if="member.dot" :class="`kb-dot ${dot}`" :title="$t(`load.links.${dot}`)"></i>{{ member.pseudo || 'Unknown Soldier' }}</span>
      </div>
      <div class="kb-status"><i :class="full ? 'kb-ok' : ''"></i><span>{{ status }}</span><small>{{ eta }}</small></div>
      <div class="kb-timeline">
        <div v-for="part in parts" :key="part.key" :class="['kb-part', part.pct >= 100 ? 'done' : part.pct > 0 ? 'now' : 'wait']">
          <div class="kb-track"><i :style="{ width: `${part.pct}%` }"></i></div><span>{{ $t(`load.parts.${part.key}`) }}<em>{{ part.pct > 0 && part.pct < 100 ? $n(part.pct / 100, { style: 'percent' }) : '' }}</em></span>
        </div>
      </div>
      <p :class="['kb-prompt', { 'kb-off': view.screen !== 'ready' }]">{{ $t('load.enter') }}</p>
      <p class="kb-note" :hidden="!(view.screen === 'ready' && view.declined)"><b>{{ $t('load.mouseRefused') }}</b> {{ $t('load.clickAgain') }}</p>
      <div class="kb-error" :hidden="!problem">
        <h3><span class="kb-warn">!</span><span class="kb-error-title">{{ problem?.title }}</span></h3><p class="kb-error-text">{{ problem?.text }}</p><p class="kb-error-hint">{{ problem?.hint ?? '' }}</p>
        <div class="kb-error-actions"><button class="kb-primary" type="button" :hidden="!problem?.primary" @click="problem?.primary?.[1]()">{{ problem?.primary?.[0] }}</button><button class="kb-secondary kb-copy" type="button" :hidden="!problem?.report" @click="copy">{{ $t(`errors.${ui.copy}`) }}</button><a class="kb-secondary" :href="BASE">{{ $t('errors.menu') }}</a></div>
        <details ref="details" class="kb-details" :hidden="!problem?.report"><summary>{{ $t('errors.details') }}</summary><pre ref="pre">{{ view.report }}</pre></details>
      </div>
    </div>
    <aside class="kb-tip"><b>{{ $t('load.tip') }}</b><span>{{ $t(`load.tips.${ui.tip}`) }}</span></aside>
  </section>
</template>
