import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  build: {
    assets: '_assets',
  },
  vite: {
    server: {
      proxy: {},
    },
    plugins: [
      {
        name: 'spa-fallback-agent',
        configureServer(server) {
          server.middlewares.use((req, _res, next) => {
            // Rewrite /agent/anything to /agent/ so Astro serves the [...slug] page
            if (req.url && req.url.startsWith('/agent/') && req.url !== '/agent/') {
              req.url = '/agent/';
            }
            next();
          });
        },
      },
    ],
  },
});
