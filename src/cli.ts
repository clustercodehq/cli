#!/usr/bin/env node

import { config as loadEnv } from "dotenv";
import { program } from "commander";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loginCommand } from "./commands/login.js";
import { workerCommand } from "./commands/worker.js";
import { doctorCommand } from "./commands/doctor.js";
import { onboardCommand } from "./commands/onboard.js";
import { configCommand } from "./commands/config.js";
import { statusCommand } from "./commands/status.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from the CLI package root — dotenv won't overwrite existing vars
loadEnv({ path: join(__dirname, "..", ".env"), quiet: true });

const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

program
  .name("clustercode")
  .description("CLI for the Cluster Code platform")
  .version(pkg.version);

program.addCommand(loginCommand);
program.addCommand(workerCommand);
program.addCommand(doctorCommand);
program.addCommand(onboardCommand);
program.addCommand(configCommand);
program.addCommand(statusCommand);

program.parse();
