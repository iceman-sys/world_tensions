import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  publicDir: false,
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
  worker: {
    format: 'es',
  },
  // pre-bundle everything up front, so the dev server never re-optimizes (and reloads the page) mid-session
  optimizeDeps: {
    include: ['three', 'three/addons/controls/OrbitControls.js', 'three/addons/utils/BufferGeometryUtils.js'],
  },
  server: {
    port: 5173,
    strictPort: true,
    // explicit IPv4: "localhost" can resolve to ::1, which some setups refuse
    host: '127.0.0.1',
  },
});
