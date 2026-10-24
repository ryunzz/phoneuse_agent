import { networkInterfaces } from 'node:os';
import { loadConfig } from './config.js';
import { JsonFileStore } from './store.js';

/** The Mac's Wi-Fi address, which the iPhone app uses to reach this gateway. */
function lanAddress(): string | null {
  const all = networkInterfaces();
  const ordered = [...(all.en0 ?? []), ...Object.values(all).flat()];
  return ordered.find((entry) => entry && entry.family === 'IPv4' && !entry.internal)?.address ?? null;
}

const USAGE = `Usage:
  bun run admin create-key <name>    Issue an API key (shown once)
  bun run admin create-rig <name>    Register a rig and issue its token (shown once)
  bun run admin create-contributor <name>   Issue an iPhone app pairing string (shown once)
  bun run admin revoke-key <key_id>
  bun run admin revoke-contributor <contributor_id>
  bun run admin list`;

function main(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  const config = loadConfig();
  const store = new JsonFileStore(`${config.dataDir}/store.json`);
  const name = rest.join(' ');
  switch (command) {
    case 'create-key': {
      const { record, secret } = store.createKey(name);
      console.info(`Created ${record.id} (${record.name})\nAPI key: ${secret}\nStore it now; it cannot be shown again.`);
      return 0;
    }
    case 'create-rig': {
      const { record, secret } = store.createRig(name);
      console.info(`Registered ${record.id} (${record.name})\nRig token: ${secret}\nRun: GATEWAY_URL=... RIG_TOKEN=... uv run rig_agent.py`);
      return 0;
    }
    case 'create-contributor': {
      const { record, secret } = store.createContributor(name);
      const host = lanAddress() ?? '<mac-ip>';
      console.info(`Created ${record.id} (${record.name})
Pairing string (paste into the app's Settings):
  http://${host}:${config.port}#${secret}
Simulator on this Mac:
  http://127.0.0.1:${config.port}#${secret}
Run the gateway with HOST=0.0.0.0 so the phone can reach it. Store this now; it cannot be shown again.`);
      return 0;
    }
    case 'revoke-contributor':
      console.info(`Revoked ${store.revokeContributor(name).id}`);
      return 0;
    case 'revoke-key':
      console.info(`Revoked ${store.revokeKey(name).id}`);
      return 0;
    case 'list':
      for (const key of store.listKeys()) console.info(`key ${key.id}  ${key.name}${key.revoked ? '  (revoked)' : ''}`);
      for (const rig of store.listRigs()) console.info(`rig ${rig.id}  ${rig.name}`);
      for (const person of store.listContributors()) console.info(`contributor ${person.id}  ${person.name}${person.revoked ? '  (revoked)' : ''}`);
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
