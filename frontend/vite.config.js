import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // VITE_BASE lets the same build be served from a sub-path (GitHub Pages).
  base: process.env.VITE_BASE || "/",
  // host: true listens on the Wi-Fi address too, so phones on the same network can open QR links.
  server: { host: true, port: 5173 },
});
