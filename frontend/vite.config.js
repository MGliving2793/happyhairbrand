import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../public/checkout-app', // Output directly to the public folder
    emptyOutDir: true,
    rollupOptions: {
      input: 'src/main.jsx',
      output: {
        entryFileNames: 'checkout-bundle.js',
        chunkFileNames: 'checkout-bundle-[name].js',
        assetFileNames: 'checkout-assets.[ext]'
      }
    }
  }
})
