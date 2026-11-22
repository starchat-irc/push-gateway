/**
 * Starts the gateway: node src/index.js (settings in the environment, see the README).
 */
import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { createFcmClient } from './fcm.js';
import { createGateway } from './gateway.js';

const log = (message) => console.log(`${new Date().toISOString()} ${message}`);

let config;
try {
    config = loadConfig(process.env);
} catch (error) {
    console.error(error.message);
    process.exit(1);
}

const gateway = createGateway({
    key: config.key,
    publicUrl: config.publicUrl,
    fcm: createFcmClient({ account: config.account }),
    trustProxy: config.trustProxy,
    log,
});

const server = createServer(gateway.handle);
server.requestTimeout = 15000;
server.headersTimeout = 10000;

const pruning = setInterval(gateway.prune, 60000);
pruning.unref();

server.listen(config.port, () => {
    log(`push gateway for Firebase project ${config.account.project_id} on port ${config.port}, endpoints under ${config.publicUrl}/push/`);
});

function stop() {
    log('stopping');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
