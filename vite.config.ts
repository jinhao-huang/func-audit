import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  optimizeDeps: { entries: ["app/components/**/*.tsx"] },
  resolve: { tsconfigPaths: true },
  server: {
    host: "127.0.0.1",
    fs: { deny: [".env", ".env.*", "*.{crt,pem,key,p12,pfx,cer,der}", ".npmrc", ".yarnrc.yml", "**/.git/**", "**/mise.local.toml", "**/data/**", "**/.func-audit.sqlite*"] },
  },
});
