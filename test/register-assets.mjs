// Lets Node load assets/*.png the way Wrangler's "Data" rule does (as an ArrayBuffer).
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`
  import { readFileSync } from "node:fs";
  import { fileURLToPath } from "node:url";
  export async function load(url, ctx, next) {
    if (/\\.(png|jpe?g)$/.test(url)) {
      const b = readFileSync(fileURLToPath(url));
      return { format: "module", shortCircuit: true,
        source: "export default new Uint8Array([" + Array.from(b).join(",") + "]).buffer;" };
    }
    return next(url, ctx);
  }`));
