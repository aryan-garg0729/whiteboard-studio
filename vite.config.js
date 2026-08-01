import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'src/ui',
  base: './',                 // Electron loads dist/index.html over file://
  build: { outDir: '../../dist', emptyOutDir: true },
  server: { port: 5173, strictPort: true },
});
