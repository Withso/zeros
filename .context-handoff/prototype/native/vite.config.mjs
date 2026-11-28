import {defineConfig} from "vite";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
 base:"./",publicDir:false,
 plugins:[tailwindcss()],
 resolve:{alias:{"@":"/Users/devin/repos/zeros/apps/desktop/src"},dedupe:["react","react-dom"]},
 esbuild:{jsx:"automatic"},
 build:{assetsInlineLimit:1000000,cssCodeSplit:false,modulePreload:false}
});
