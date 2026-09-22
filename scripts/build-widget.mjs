// Builds the storefront scripts from packages/widget/src into the theme
// extension's assets (theme app extensions only ship assets/, blocks/,
// locales/ and snippets/, so the source lives outside the extension).
//
//   node scripts/build-widget.mjs          write the assets
//   node scripts/build-widget.mjs --check  fail if the committed assets are stale
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENTRIES = {
  "cartlift.js": "packages/widget/src/cartlift.ts",
  "cartlift-cart.js": "packages/widget/src/cartlift-cart.ts",
};
const BANNER = "/* CartLift — built from packages/widget/src by scripts/build-widget.mjs. Do not edit. */";

export async function bundle() {
  const out = {};
  for (const [asset, entry] of Object.entries(ENTRIES)) {
    const result = await build({
      entryPoints: [path.join(root, entry)],
      bundle: true,
      format: "iife",
      // Storefront browsers: Shopify supports the last two versions of evergreen browsers.
      target: ["es2019"],
      minify: true,
      legalComments: "none",
      banner: { js: BANNER },
      write: false,
      logLevel: "silent",
    });
    out[asset] = result.outputFiles[0].text;
  }
  return out;
}

const assetPath = (asset) => path.join(root, "extensions/cartlift-widget/assets", asset);

async function main() {
  const check = process.argv.includes("--check");
  const built = await bundle();
  let stale = false;
  for (const [asset, code] of Object.entries(built)) {
    if (check) {
      let current = "";
      try {
        current = readFileSync(assetPath(asset), "utf8");
      } catch {
        // Missing counts as stale.
      }
      if (current.replace(/\r\n/g, "\n") !== code) {
        console.error(`${asset} is stale — run: npm run build:widget`);
        stale = true;
      }
    } else {
      writeFileSync(assetPath(asset), code);
      console.log(`${asset}  ${(code.length / 1024).toFixed(1)} KB`);
    }
  }
  if (stale) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
