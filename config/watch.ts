import Bun, { $ } from "bun";
import { parseArgs } from "util";
import { watch } from "fs";
import type { FSWatcher } from "fs";
import chalk from "chalk";

import "./cwd";
import { server, channel } from "./server";

const {
  values: { dir },
} = parseArgs({
  args: Bun.argv,
  strict: true,
  allowPositionals: true,
  options: {
    dir: {
      type: "string",
    },
  },
});

const directoriesToWatch = dir?.split(",").map((dir) => `./${dir}`) || [];

const runBuild = async () => $`bun run config/build.ts`;
await runBuild();

const directories = directoriesToWatch.join(", ");
const defaultWatchMessage = `Watching ${directories} directories for changes...`;

console.log(chalk.bold(defaultWatchMessage))

const watchers: FSWatcher[] = [];

for (const directory of directoriesToWatch) {
  const watcher = watch(directory, { recursive: true }, async (_, filename) => {
    console.log(chalk.bold.yellow.dim(`Changes detected in ${filename}`))
    
    await runBuild();
    console.log(chalk.bold.green("✔️ Updated build files"))

    server.publish(channel, Bun.env.CHROME_EXTENSION_ID as string);

    console.log(chalk.bold(defaultWatchMessage))
  });

  watchers.push(watcher);
}

process.on("SIGINT", () => {
  for (const watcher of watchers) {
    watcher.close();
  }

  process.exit(0);
});
