#!/usr/bin/env bun

const target = Bun.argv[2];
const remoteDir = "/home/peerpay";
const binaryPath = "dist/peerpay";

if (!target) {
  console.error("Usage: bun run publish root@your-server");
  process.exit(1);
}

async function run(command: string[]) {
  const proc = Bun.spawn(command, {
    stdout: "inherit",
    stderr: "inherit"
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Command failed (${code}): ${command.join(" ")}`);
  }
}

await run([
  "bun",
  "build",
  "--compile",
  "--target=bun-linux-x64",
  "--production",
  "--outfile",
  binaryPath,
  "./server/index.ts"
]);

await run(["ssh", target, `mkdir -p ${remoteDir}`]);
await run(["scp", binaryPath, "ecosystem.config.js", `${target}:${remoteDir}/`]);
await run(["ssh", target, `chmod +x ${remoteDir}/peerpay`]);

console.log(`Published PeerPay to ${target}:${remoteDir}`);
console.log(`Start it on the server with: cd ${remoteDir} && pm2 start`);
