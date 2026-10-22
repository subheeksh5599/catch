// Vercel output: the landing page at / and the dashboard at /app/.
import { cpSync, rmSync, mkdirSync } from "node:fs";
const out = new URL("../dist/", import.meta.url);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(new URL("../site/", import.meta.url), out, { recursive: true });
cpSync(new URL("../app/", import.meta.url), new URL("app/", out), { recursive: true });
console.log("built dist/ (site + app)");
