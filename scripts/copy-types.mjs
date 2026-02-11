import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const source = path.resolve(__dirname, "../src/cloudflare-test/module-declarations.d.ts");
const target = path.resolve(__dirname, "../dist/cloudflare-test/module-declarations.d.ts");

await fs.mkdir(path.dirname(target), { recursive: true });
await fs.copyFile(source, target);
