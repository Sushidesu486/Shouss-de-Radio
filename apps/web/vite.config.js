import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({
    plugins: [react()],
    server: {
        proxy: {
            "/ws": {
                target: "ws://127.0.0.1:3000",
                ws: true
            },
            "/health": {
                target: "http://127.0.0.1:3000"
            }
        }
    }
});
