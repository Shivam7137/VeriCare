import { spawn } from "node:child_process";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
loadEnvFile(resolve(root, ".env"));
const child = spawn(
  process.execPath,
  [
    resolve(root, "node_modules/next/dist/bin/next"),
    process.argv[2],
    "--hostname",
    "127.0.0.1",
    "--port",
    "3100",
  ],
  { cwd: resolve(root, "apps/web"), stdio: "inherit", env: process.env },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}
