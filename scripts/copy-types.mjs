import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const source = path.resolve(__dirname, "../src/cloudflare-test/module-declarations.d.ts");
const target = path.resolve(__dirname, "../dist/cloudflare-test/module-declarations.d.ts");

await fs.mkdir(path.dirname(target), { recursive: true });
await fs.copyFile(source, target);

const filesToPatch = [
  {
    file: path.resolve(__dirname, "../dist/index.d.ts"),
    reference: "/// <reference path=\"./cloudflare-test/module-declarations.d.ts\" />"
  },
  {
    file: path.resolve(__dirname, "../dist/config/index.d.ts"),
    reference: "/// <reference path=\"../cloudflare-test/module-declarations.d.ts\" />"
  },
  {
    file: path.resolve(__dirname, "../dist/cloudflare-test/index.d.ts"),
    reference: "/// <reference path=\"./module-declarations.d.ts\" />"
  }
];

for (const { file, reference } of filesToPatch) {
  const current = await fs.readFile(file, "utf8");
  if (!current.includes(reference)) {
    await fs.writeFile(file, `${reference}\n${current}`);
  }
}

const publicTypesPath = path.resolve(__dirname, "../dist/types.d.ts");
const publicTypes = [
  "/// <reference path=\"./cloudflare-test/module-declarations.d.ts\" />",
  "export * from \"./index\";"
].join("\n");
await fs.writeFile(publicTypesPath, `${publicTypes}\n`);
