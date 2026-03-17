import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/system-design-tutor/',
  plugins: [react()],
  server: {
    fs: {
      allow: ['..'],
    },
  },
})
