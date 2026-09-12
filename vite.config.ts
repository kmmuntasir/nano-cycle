import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "../web-dist",
    emptyOutDir: true,
  },
  server: {
    port: 5199,
    proxy: {
      "/api": "http://127.0.0.1:4177",
      "/ws": { target: "ws://127.0.0.1:4177", ws: true },
    },
  },
});
