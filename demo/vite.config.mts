import { defineConfig } from "vite";

import grain from "@graints/vite-plugin";

export default defineConfig({
    // 部署在 GitHub Pages 的项目页子路径下，用相对路径最省事
    base: "./",
    plugins: [grain()],
});
