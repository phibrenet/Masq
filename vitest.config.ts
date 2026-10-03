import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      electron: resolve('tests/support/electron-shim.ts')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts']
  }
})
