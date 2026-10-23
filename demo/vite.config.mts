import { defineConfig } from "vite";

import grain from "@graints/vite-plugin";

export default defineConfig({
    // 站点部署在 GitHub Pages 的项目页子路径下
    base: "/kipphi-player/",
    // 多页：src/routes 下每条静态路由生成一个真实 HTML，
    // 静态托管不需要 404 回退，状态码也是对的
    plugins: [grain({ pages: true })],
});
