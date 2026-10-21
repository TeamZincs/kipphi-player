import { defineConfig } from "vite";

import grain from "@graints/vite-plugin";

export default defineConfig({
    // 站点部署在 GitHub Pages 的项目页子路径下；grain 的 router 用同一个 base
    // （App.grain 里 import.meta.env.BASE_URL），本地 dev 也走这个前缀
    base: "/kipphi-player/",
    plugins: [grain()],
});
