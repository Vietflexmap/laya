import { cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

const src = new URL("../node_modules/onnxruntime-web/dist/", import.meta.url);
const dst = new URL("../public/ort/", import.meta.url);

await mkdir(dst, { recursive: true });
const names = await readdir(src);
const runtimeFiles = names.filter((name) =>
  /^ort-wasm.*\.(?:wasm|mjs)$/.test(name)
);

if (runtimeFiles.length === 0) {
  throw new Error("No onnxruntime-web WASM runtime assets found");
}

for (const name of runtimeFiles) {
  await cp(new URL(name, src), new URL(name, dst));
}

console.log("Copied ONNX Runtime Web assets:", runtimeFiles.join(", "));
