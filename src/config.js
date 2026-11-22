/**
 * Settings from the environment, see the README.
 */
import { readFileSync } from 'node:fs';
import { parseKey } from './endpoint.js';
import { parseServiceAccount } from './fcm.js';

const DEFAULT_SERVICE_ACCOUNT_FILE = '/run/secrets/fcm-service-account.json';

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {(file: string) => string} [readFile]
 */
export function loadConfig(env, readFile = (file) => readFileSync(file, 'utf8')) {
    const publicUrl = String(env.PUBLIC_URL ?? '').trim();
    let url;
    try {
        url = new URL(publicUrl);
    } catch {
        throw new Error('PUBLIC_URL is missing or not a URL, e.g. https://push.example.org');
    }
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
        throw new Error('PUBLIC_URL must use https: IRC servers only push to secure endpoints');
    }

    let accountJson = env.FCM_SERVICE_ACCOUNT;
    if (!accountJson) {
        const file = env.FCM_SERVICE_ACCOUNT_FILE || DEFAULT_SERVICE_ACCOUNT_FILE;
        try {
            accountJson = readFile(file);
        } catch {
            throw new Error(`FCM service account not found: set FCM_SERVICE_ACCOUNT or mount the key file at ${file}`);
        }
    }

    const port = Number.parseInt(env.PORT ?? '8080', 10);
    if (!(port > 0 && port < 65536)) {
        throw new Error('PORT must be a port number');
    }

    return {
        publicUrl: url.href.replace(/\/+$/, ''),
        key: parseKey(env.GATEWAY_KEY),
        account: parseServiceAccount(accountJson),
        port,
        trustProxy: ['1', 'true', 'yes'].includes(String(env.TRUST_PROXY ?? '').toLowerCase()),
    };
}
