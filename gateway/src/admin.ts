import { loadConfig } from './config.js';
import { JsonFileStore } from './store.js';

const USAGE = `Usage:
  npm run admin -- create-key <name>    Issue an API key (shown once)
  npm run admin -- create-rig <name>    Register a rig and issue its token (shown once)
  npm run admin -- revoke-key <key_id>
  npm run admin -- list`;

function main(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  const store = new JsonFileStore(`${loadConfig().dataDir}/store.json`);
  const name = rest.join(' ');
  switch (command) {
    case 'create-key': {
      const { record, secret } = store.createKey(name);
      console.info(`Created ${record.id} (${record.name})\nAPI key: ${secret}\nStore it now; it cannot be shown again.`);
      return 0;
    }
    case 'create-rig': {
      const { record, secret } = store.createRig(name);
      console.info(`Registered ${record.id} (${record.name})\nRig token: ${secret}\nRun: GATEWAY_URL=... RIG_TOKEN=... python3 rig_agent.py`);
      return 0;
    }
    case 'revoke-key':
      console.info(`Revoked ${store.revokeKey(name).id}`);
      return 0;
    case 'list':
      for (const key of store.listKeys()) console.info(`key ${key.id}  ${key.name}${key.revoked ? '  (revoked)' : ''}`);
      for (const rig of store.listRigs()) console.info(`rig ${rig.id}  ${rig.name}`);
      return 0;
    default:
      console.error(USAGE);
      return 1;
  }
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
