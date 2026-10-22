import pkg from './package.json' with { type: 'json' };
import { defineConfig } from 'vite';


export default defineConfig({
  clearScreen: false,
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        form: 'form.html',
        gallery: 'dev/gallery.html',
      },
    },
  },
});
