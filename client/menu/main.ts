import { createApp } from 'vue';
import { i18n } from '../i18n/index.ts';
import App from './App.vue';
import './menu.css';

createApp(App).use(i18n).mount('#app');
