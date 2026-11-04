import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Builds one bundle (main.js + main.css) loaded by both the chat view and the config panel. */
export default defineConfig({
  plugins: [react()],
  base: "./",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "../extension/media/webview",
    emptyOutDir: true,
    sourcemap: true,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: "src/main.tsx",
      output: {
        entryFileNames: "main.js",
        chunkFileNames: "[name].js",
        assetFileNames: (asset) => (asset.names?.some((n) => n.endsWith(".css")) ? "main.css" : "[name][extname]"),
        codeSplitting: false,
      },
    },
  },
});
