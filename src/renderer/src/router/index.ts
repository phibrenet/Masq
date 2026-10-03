import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'

/**
 * Hash history (`createWebHashHistory`) — safest under Electron's `file://` production
 * loading, where HTML5 history routing breaks. The sections mirror the pipeline stages:
 * connect → classify → select → relate → anonymize → run.
 */
const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/connections' },
  {
    path: '/connections',
    name: 'connections',
    component: () => import('@renderer/views/ConnectionsView.vue'),
    meta: { title: 'Connections' }
  },
  {
    path: '/tables',
    name: 'tables',
    component: () => import('@renderer/views/TablesView.vue'),
    meta: { title: 'Tables' }
  },
  {
    path: '/rules',
    name: 'rules',
    component: () => import('@renderer/views/RulesView.vue'),
    meta: { title: 'Selection Rules' }
  },
  {
    path: '/backfill',
    name: 'backfill',
    component: () => import('@renderer/views/BackfillView.vue'),
    meta: { title: 'Backfill Management' }
  },
  {
    path: '/fields',
    name: 'fields',
    component: () => import('@renderer/views/FieldsView.vue'),
    meta: { title: 'Field Strategies' }
  },
  {
    path: '/morphs',
    name: 'morphs',
    component: () => import('@renderer/views/MorphsView.vue'),
    meta: { title: 'Polymorphic Relations' }
  },
  {
    path: '/runs',
    name: 'runs',
    component: () => import('@renderer/views/RunsView.vue'),
    meta: { title: 'Runs' }
  }
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes
})
