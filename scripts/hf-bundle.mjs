// Assembles the Hugging Face Space folder (work/hf-space) from this repository.
// It copies the files Git would track, minus training data, docs and the pitch video, and puts the Space's
// Dockerfile and README at its root. Local secrets (.env, sessions) are ignored by Git.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, "work/hf-space");
const skipped =
  /^(ml|docs|pitch|work|\.claude|\.superpowers|\.impeccable|deploy\/huggingface\/(Dockerfile|README\.md))(\/|$)/;

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  {
    cwd: root,
    encoding: "utf8",
  },
)
  .split("\0")
  .filter((file) => file && !skipped.test(file) && !/(^|\/)\.env(\.|$)/.test(file));

rmSync(out, { recursive: true, force: true });
for (const file of files) {
  const target = resolve(out, file);
  mkdirSync(dirname(target), { recursive: true });
  try {
    cpSync(resolve(root, file), target);
  } catch (error) {
    // A tracked file deleted in the working tree is simply left out.
    if (error?.code !== "ENOENT") throw error;
  }
}
cpSync(resolve(root, "deploy/huggingface/Dockerfile"), resolve(out, "Dockerfile"));
cpSync(resolve(root, "deploy/huggingface/README.md"), resolve(out, "README.md"));
console.log(`Hugging Face Space folder ready: ${out} (${files.length + 2} files)`);
