import {existsSync} from 'node:fs';
import {ConfigurationError,loadConfig} from '../apps/server/src/infrastructure/config.js';
import {loadSecrets} from '../apps/server/src/infrastructure/secrets.js';
import {loadPasswordBlocklist} from '../apps/server/src/infrastructure/password-blocklist.js';
try {
  const args=process.argv.slice(2);
  if(args[0]==='--')args.shift();
  if(args.length>1||(args.length===1&&!/^--mode=(development|production|test)$/.test(args[0]!)))throw new ConfigurationError(['MODE']);
  if(existsSync('.env')){
    try{process.loadEnvFile('.env');}catch{throw new ConfigurationError(['ENV_FILE']);}
  }
  const mode=args[0]?.slice('--mode='.length);
  const config=loadConfig({...process.env,...(mode?{NODE_ENV:mode}:{})});
  await loadSecrets(config);
  await loadPasswordBlocklist();
  console.log(`Configuration valid (${config.environment}). Secret files and offline password blocklist verified. Database and SMTP connectivity were not checked.`);
} catch(error) {
  console.error(error instanceof ConfigurationError?error.message:'Invalid configuration: ENV_CHECK');
  process.exitCode=2;
}
