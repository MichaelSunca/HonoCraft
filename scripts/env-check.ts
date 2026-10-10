import { existsSync } from 'node:fs';
import { loadConfig } from '../apps/server/src/infrastructure/config.js';
if (existsSync('.env')) process.loadEnvFile('.env');
try {
  const config = loadConfig(process.env);
  console.log(`Configuration valid (${config.environment}). Secret file contents are checked at process startup.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Configuration invalid');
  process.exitCode = 2;
}
