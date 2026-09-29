import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const entry = ".output/server/index.mjs";
if (!existsSync(entry)) {
  console.error("还没有构建。在项目目录运行：npm install && npm run build");
  process.exit(1);
}

const port = process.env.PORT ?? "8787";
const host = process.env.HOST ?? "0.0.0.0";

function record() {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--import", "./scripts/alias.mjs", "scripts/record-journal.ts"], {
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    if (code) console.error(`record-journal exited ${code}`);
  });
}

record();
const timer = setInterval(record, 60_000);

const server = spawn(process.execPath, [entry], {
  stdio: "inherit",
  env: {
    ...process.env,
    PORT: port,
    HOST: host,
    NITRO_PORT: port,
    NITRO_HOST: host,
  },
});

function shutdown() {
  clearInterval(timer);
  server.kill("SIGTERM");
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
server.on("exit", (code) => process.exit(code ?? 0));

console.log(`赤衡在本机 ${host}:${port} 上提供访问。同一局域网用这台电脑的 IP 加端口打开。`);
