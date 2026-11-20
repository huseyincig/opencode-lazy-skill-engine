import { spawnSync } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run("npm", ["run", "typecheck:strict"]);
run("npm", ["run", "build"]);

for (const requiredFile of ["index.js", "tui.js", "dist/index.d.ts", "dist/tui.d.ts", "dist/stats-rpc.d.ts"]) {
  await access(requiredFile);
}

async function walk(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(path)));
    else if (ent.name.endsWith(".js") || ent.name.endsWith(".mjs")) out.push(path);
  }
  return out;
}

const list = ["index.js", "tui.js", ...(await walk("dist")), ...(await walk("tests")), ...(await walk("scripts"))];
for (const path of list) run(process.execPath, ["--check", path]);
console.log(`PASS: ${list.length} JavaScript modules syntax`);
run(process.execPath, ["--test"]);
