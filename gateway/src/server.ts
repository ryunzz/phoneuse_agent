import { lanAddress, loadConfig } from './config.js';
import { createGateway } from './http.js';
import { JsonFileStore } from './store.js';

const config = loadConfig();
const store = new JsonFileStore(`${config.dataDir}/store.json`);
const { server } = createGateway(config, store);

server.listen(config.port, config.host, () => {
  console.info(`Phone Use gateway on http://${config.host}:${config.port} (public ${config.publicUrl})`);
  console.info(`MCP endpoint: ${config.publicUrl}/mcp  |  ${store.listRigs().length} rig(s), ${store.listKeys().length} key(s)`);
  const lan = lanAddress();
  if (config.host === '0.0.0.0' && lan) {
    console.info(`iPhone app: pair with http://${lan}:${config.port}#<ct_ key>  |  review: http://127.0.0.1:${config.port}/review/submissions`);
  } else if (config.host !== '0.0.0.0') {
    console.info('iPhone app: not reachable from the phone; start with `bun run phone` (HOST=0.0.0.0) instead');
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
