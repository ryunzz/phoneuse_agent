import { loadConfig } from './config.js';
import { createGateway } from './http.js';
import { JsonFileStore } from './store.js';

const config = loadConfig();
const store = new JsonFileStore(`${config.dataDir}/store.json`);
const { server } = createGateway(config, store);

server.listen(config.port, config.host, () => {
  console.info(`Phone Use gateway on http://${config.host}:${config.port} (public ${config.publicUrl})`);
  console.info(`MCP endpoint: ${config.publicUrl}/mcp  |  ${store.listRigs().length} rig(s), ${store.listKeys().length} key(s)`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
