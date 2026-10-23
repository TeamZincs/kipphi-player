import { copyFileSync } from "node:fs";
import { join } from "node:path";

import { defineConfig, type Plugin } from "vite";

import grain from "@graints/vite-plugin";

/**
 * GitHub Pages 的 SPA 兜底
 *
 * 整个应用只有一个 index.html，`/kipphi-player/record` 这种深链接在 Pages 上
 * 会直接 404（静态托管没有「找不到就回 index.html」这回事）。
 * Pages 对找不到的路径会**返回根目录的 `404.html`** —— 把 index.html 拷一份过去，
 * 前端路由就能接管，刷新和分享链接都不会挂。
 *
 * 之所以能这么简单：`base` 是绝对的（`/kipphi-player/`），404.html 里引的
 * `/kipphi-player/assets/xxx.js` 换个路径也照样解析得到。
 */
function spaFallback(): Plugin {
    let outDir = "dist";

    return {
        name: "spa-fallback-404",
        apply: "build",
        configResolved(config) {
            outDir = config.build.outDir;
        },
        closeBundle() {
            copyFileSync(join(outDir, "index.html"), join(outDir, "404.html"));
        },
    };
}

export default defineConfig({
    // 站点部署在 GitHub Pages 的项目页子路径下；grain 的 router 用同一个 base
    // （App.grain 里 import.meta.env.BASE_URL），本地 dev 也走这个前缀
    base: "/kipphi-player/",
    plugins: [grain(), spaFallback()],
});
