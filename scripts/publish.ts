#!/usr/bin/env bun

const target = Bun.argv[2];
const remoteDir = "/home/peerpay";
const binaryPath = "dist/peerpay";
const remoteBinaryPath = `${remoteDir}/peerpay`;
const remoteUploadPath = `${remoteBinaryPath}.upload-${Date.now()}`;

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

async function succeeds(command: string[]) {
  const proc = Bun.spawn(command, {
    stdout: "ignore",
    stderr: "ignore"
  });
  return await proc.exited === 0;
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
await run(["scp", binaryPath, `${target}:${remoteUploadPath}`]);
await run(["ssh", target, `chmod +x ${remoteUploadPath} && mv -f ${remoteUploadPath} ${remoteBinaryPath}`]);

const remoteEcosystemPath = `${remoteDir}/ecosystem.config.js`;
if (await succeeds(["ssh", target, `test -f ${remoteEcosystemPath}`])) {
  console.log(`Skipped existing ${target}:${remoteEcosystemPath}`);
} else {
  await run(["scp", "ecosystem.config.js", `${target}:${remoteDir}/`]);
}

console.log(`Published PeerPay to ${target}:${remoteDir}`);
console.log(`Start it on the server with: cd ${remoteDir} && pm2 start`);
