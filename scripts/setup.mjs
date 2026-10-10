import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const envFile = resolve(root, ".env");
if (!existsSync(envFile)) {
  copyFileSync(resolve(root, ".env.example"), envFile);
  console.log("Created .env with synthetic local settings.");
} else {
  console.log("Kept existing .env.");
}
console.log("Next: npm run db:up, npm run db:migrate, npm run db:seed, npm run dev");
