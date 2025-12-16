import 'element-plus/dist/index.css';

import ElementPlus from 'element-plus';
import { createPinia } from 'pinia';
import { createApp } from 'vue';

import App from './App.vue';
import './styles/main.scss';

const app = createApp(App);
app.use(createPinia());
app.use(ElementPlus);
app.mount('#app');
