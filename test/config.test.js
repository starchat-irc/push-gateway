import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config.js';

const account = JSON.stringify({ project_id: 'p', client_email: 'e@p.iam.gserviceaccount.com', private_key: 'pem' });
const env = {
    PUBLIC_URL: 'https://push.example.org/',
    GATEWAY_KEY: randomBytes(32).toString('base64'),
    FCM_SERVICE_ACCOUNT: account,
};

test('settings from the environment', () => {
    const config = loadConfig(env);
    assert.equal(config.publicUrl, 'https://push.example.org');
    assert.equal(config.port, 8080);
    assert.equal(config.trustProxy, false);
    assert.equal(config.account.project_id, 'p');
    assert.equal(loadConfig({ ...env, TRUST_PROXY: 'true', PORT: '3000' }).port, 3000);
});

test('the service account is read from the secret file by default', () => {
    const read = [];
    const config = loadConfig({ ...env, FCM_SERVICE_ACCOUNT: '' }, (file) => {
        read.push(file);
        return account;
    });
    assert.equal(config.account.client_email, 'e@p.iam.gserviceaccount.com');
    assert.deepEqual(read, ['/run/secrets/fcm-service-account.json']);
    assert.throws(() => loadConfig({ ...env, FCM_SERVICE_ACCOUNT: '' }, () => {
        throw new Error('ENOENT');
    }), /service account not found/);
});

test('missing or unsafe settings stop the start', () => {
    assert.throws(() => loadConfig({ ...env, PUBLIC_URL: '' }), /PUBLIC_URL/);
    assert.throws(() => loadConfig({ ...env, PUBLIC_URL: 'http://push.example.org' }), /https/);
    assert.equal(loadConfig({ ...env, PUBLIC_URL: 'http://localhost:8080' }).publicUrl, 'http://localhost:8080');
    assert.throws(() => loadConfig({ ...env, GATEWAY_KEY: 'short' }), /GATEWAY_KEY/);
    assert.throws(() => loadConfig({ ...env, PORT: 'x' }), /PORT/);
});
