import { advertise } from './bonjour.js';
import { lanAddress, loadConfig } from './config.js';
import { createGateway } from './http.js';
import { JsonFileStore } from './store.js';

const config = loadConfig();
const store = new JsonFileStore(`${config.dataDir}/store.json`);
const { server } = createGateway(config, store);

const stopAdvertising = config.host === '0.0.0.0' ? advertise(config.port) : () => {};

server.listen(config.port, config.host, () => {
  console.info(`Phone Use gateway on http://${config.host}:${config.port} (public ${config.publicUrl})`);
  console.info(`MCP endpoint: ${config.publicUrl}/mcp  |  ${store.listRigs().length} rig(s), ${store.listKeys().length} key(s)`);
  const lan = lanAddress();
  if (config.host === '0.0.0.0' && lan) {
    console.info(`iPhone app: finds this Mac automatically${config.openEnrollment ? ' and signs itself up' : ''} (http://${lan}:${config.port})`);
    console.info(`Review: http://127.0.0.1:${config.port}/review/submissions`);
  } else if (config.host !== '0.0.0.0') {
    console.info('iPhone app: not reachable from the phone; start with `bun run phone` instead');
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopAdvertising();
    server.close(() => process.exit(0));
  });
}
