import { defineConfig } from "vite";

export default defineConfig({
    // 用相对路径引用产物：GitHub Pages 的项目页（/kipphi-player/）也能直接跑，
    // 不依赖部署在域名根目录
    base: "./",
});
