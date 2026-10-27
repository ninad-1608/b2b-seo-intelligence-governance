// Builds / starts the web app for guest sessions: the browser calls the API on the SAME origin (through the guard proxy)
// instead of the baked-in http://127.0.0.1:8010, which a guest's own machine could never reach.
// Output goes to .next-guest so your normal build in .next is untouched.
import { spawn } from "node:child_process";

const mode = process.argv[2];
if (mode !== "build" && mode !== "start") {
  console.error("usage: node scripts/guest-next.mjs build|start");
  process.exit(2);
}
const port = process.env.GUEST_FRONTEND_PORT || "3300";
const env = { ...process.env, NEXT_PUBLIC_API_URL: "", NEXT_DIST_DIR: ".next-guest" };
// start listens on loopback only: the guard proxy is the only way in
const args = mode === "build" ? ["next", "build"] : ["next", "start", "-H", "127.0.0.1", "-p", port];
const child = spawn("npx", args, { stdio: "inherit", env, shell: true });
child.on("exit", (code) => process.exit(code ?? 1));
