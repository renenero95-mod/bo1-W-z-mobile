import { createI18n } from 'vue-i18n';
import en from './en.ts';
import fr from './fr.ts';

type Lang = 'en' | 'fr';
export const LANGS: Record<Lang, string> = { fr: 'Français', en: 'English' };
const KEY = 'bo1z-lang';
const isLang = (code: string | null): code is Lang => code === 'en' || code === 'fr';

let chosen: string | null = null;
try {
  chosen = localStorage.getItem(KEY);
} catch {}
// The choice made in Options, then the browser's languages in order, then English.
const lang = [chosen, ...navigator.languages.map(tag => tag.slice(0, 2))].find(isLang) ?? 'en';

export const i18n = createI18n({
  legacy: false,
  locale: lang,
  fallbackLocale: 'en',
  messages: { en, fr },
  // French keeps the singular for zero: « 0 saccade ».
  pluralRules: { fr: choice => (choice > 1 ? 1 : 0) },
});
document.documentElement.lang = lang;

export function setLang(next: Lang) {
  i18n.global.locale.value = next;
  document.documentElement.lang = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {}
}

type Messages = typeof en;
declare module 'vue-i18n' {
  export interface DefineLocaleMessage extends Messages {}
}
