import './assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from '@renderer/router'

createApp(App).use(createPinia()).use(router).mount('#app')
