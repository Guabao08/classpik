import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The app routes on real paths now, so /app and /signup have to be served the
  // same index.html as /. Stated rather than left to the default, because the
  // day this becomes 'mpa' or 'custom' a hard refresh on /app starts 404ing and
  // nothing else explains why.
  appType: 'spa',
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
  },
})
