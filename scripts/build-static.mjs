// Vercel output: the landing page at / and the dashboard (built from dashboard/) at /app/.
import { cpSync, rmSync, mkdirSync, existsSync } from "node:fs";
const out = new URL("../dist/", import.meta.url);
const app = new URL("../dashboard/dist/", import.meta.url);
if (!existsSync(app)) throw new Error("dashboard/dist is missing: run npm --prefix dashboard run build first");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(new URL("../site/", import.meta.url), out, { recursive: true });
cpSync(app, new URL("app/", out), { recursive: true });
console.log("built dist/ (site + dashboard)");
