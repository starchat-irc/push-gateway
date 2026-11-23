import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { sealToken } from '../src/endpoint.js';
import { createGateway, isUrgent, parseTtl } from '../src/gateway.js';

const key = randomBytes(32);
const fcmToken = 'cK3c9xJ2Q0e:APA91bF-test_token-1234567890';

/** FCM stand-in: answers with `results` in order, else 'sent'. */
function fakeFcm(results = []) {
    const calls = [];
    return {
        calls,
        async send(token, body, options) {
            calls.push({ type: 'send', token, body, options });
            return results.shift() ?? { status: 'sent' };
        },
        async validate(token) {
            calls.push({ type: 'validate', token });
            return results.shift() ?? { status: 'sent' };
        },
    };
}

/** Runs the gateway on a free port for one test. */
async function withGateway(options, run) {
    const logs = [];
    const gateway = createGateway({ key, publicUrl: 'https://push.example.org/', log: (line) => logs.push(line), ...options });
    const server = createServer(gateway.handle);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        await run(base, logs);
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
}

const register = (base, body, headers = {}) => fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
});

const push = (base, id, body = Buffer.from('encrypted'), headers = {}) => fetch(`${base}/push/${id}`, {
    method: 'POST',
    headers: { 'content-encoding': 'aes128gcm', ttl: '3600', ...headers },
    body,
});

test('register: a valid token gets an endpoint that carries it', async () => {
    const fcm = fakeFcm();
    await withGateway({ fcm }, async (base) => {
        const response = await register(base, { fcm_token: fcmToken });
        assert.equal(response.status, 201);
        assert.equal(response.headers.get('access-control-allow-origin'), '*');
        const { endpoint } = await response.json();
        assert.match(endpoint, /^https:\/\/push\.example\.org\/push\/[A-Za-z0-9_-]+$/);
        assert.ok(!endpoint.includes(fcmToken));
        assert.deepEqual(fcm.calls, [{ type: 'validate', token: fcmToken }]);

        const id = endpoint.split('/push/')[1];
        assert.equal((await push(base, id)).status, 201);
        assert.equal(fcm.calls[1].token, fcmToken);
    });
});

test('register: the preflight of the app is answered', async () => {
    await withGateway({ fcm: fakeFcm() }, async (base) => {
        const response = await fetch(`${base}/register`, { method: 'OPTIONS' });
        assert.equal(response.status, 204);
        assert.equal(response.headers.get('access-control-allow-headers'), 'content-type');
    });
});

test('register: bad input and tokens of other projects are refused', async () => {
    const fcm = fakeFcm([{ status: 'unregistered', code: 'SENDER_ID_MISMATCH' }]);
    await withGateway({ fcm }, async (base) => {
        assert.equal((await register(base, '{')).status, 400);
        assert.equal((await register(base, { fcm_token: 'short' })).status, 422);
        assert.equal((await register(base, { fcm_token: 'with spaces in it, not a token' })).status, 422);
        assert.equal((await register(base, { fcm_token: fcmToken })).status, 422);
        assert.equal((await register(base, { fcm_token: 'x'.repeat(3000) })).status, 413);
        assert.equal((await fetch(`${base}/register`)).status, 405);
    });
});

test('register: an FCM outage is not taken for a bad token', async () => {
    const fcm = fakeFcm([{ status: 'failed', code: 'UNAVAILABLE' }]);
    await withGateway({ fcm }, async (base, logs) => {
        const response = await register(base, { fcm_token: fcmToken });
        assert.equal(response.status, 502);
        assert.deepEqual(logs, ['register: FCM check failed (UNAVAILABLE)']);
    });
});

test('register: limited per address, behind a proxy per forwarded address', async () => {
    await withGateway({ fcm: fakeFcm(), trustProxy: true }, async (base) => {
        const from = (address) => ({ 'x-forwarded-for': `10.0.0.1, ${address}` });
        for (let i = 0; i < 30; i++) {
            assert.equal((await register(base, { fcm_token: fcmToken }, from('192.0.2.1'))).status, 201);
        }
        const limited = await register(base, { fcm_token: fcmToken }, from('192.0.2.1'));
        assert.equal(limited.status, 429);
        assert.ok(Number(limited.headers.get('retry-after')) > 0);
        assert.equal((await register(base, { fcm_token: fcmToken }, from('192.0.2.2'))).status, 201);
    });
});

test('push: body, TTL and urgency reach FCM', async () => {
    const fcm = fakeFcm();
    await withGateway({ fcm }, async (base) => {
        const body = randomBytes(200);
        const response = await push(base, sealToken(key, fcmToken), body, { ttl: '120', urgency: 'low' });
        assert.equal(response.status, 201);
        assert.deepEqual(fcm.calls[0], { type: 'send', token: fcmToken, body, options: { ttl: 120, urgent: false } });
    });
});

test('push: FCM results become the status codes Web Push expects', async () => {
    const fcm = fakeFcm([
        { status: 'unregistered', code: 'UNREGISTERED' },
        { status: 'throttled', retryAfter: 30, code: 'QUOTA_EXCEEDED' },
        { status: 'rejected', code: 'INVALID_ARGUMENT' },
        { status: 'failed', code: 'UNAVAILABLE' },
    ]);
    await withGateway({ fcm }, async (base, logs) => {
        const id = sealToken(key, fcmToken);
        assert.equal((await push(base, id)).status, 404, 'Ergo drops subscriptions only on 404');
        const throttled = await push(base, id);
        assert.equal(throttled.status, 429);
        assert.equal(throttled.headers.get('retry-after'), '30');
        assert.equal((await push(base, id)).status, 400);
        assert.equal((await push(base, id)).status, 502);
        assert.ok(logs.every((line) => !line.includes(fcmToken) && !line.includes(id)), 'no token or id in the log');
    });
});

test('push: unknown endpoints, wrong encoding and oversized bodies are refused', async () => {
    const fcm = fakeFcm();
    await withGateway({ fcm }, async (base) => {
        const id = sealToken(key, fcmToken);
        assert.equal((await push(base, sealToken(randomBytes(32), fcmToken))).status, 404);
        assert.equal((await push(base, 'not-an-id')).status, 404);
        assert.equal((await push(base, id, Buffer.from('x'), { 'content-encoding': 'aesgcm' })).status, 415);
        assert.equal((await push(base, id, Buffer.alloc(0))).status, 400);
        assert.equal((await push(base, id, randomBytes(4097))).status, 413);
        // Fits Web Push, but not FCM's 4096 bytes once in base64
        assert.equal((await push(base, id, randomBytes(3500))).status, 413);
        assert.equal((await fetch(`${base}/push/${id}`)).status, 405);
        assert.equal(fcm.calls.length, 0);
    });
});

test('push: limited per device', async () => {
    const fcm = fakeFcm();
    await withGateway({ fcm }, async (base) => {
        const id = sealToken(key, fcmToken);
        const results = [];
        for (let i = 0; i < 61; i++) {
            results.push((await push(base, id)).status);
        }
        assert.equal(results.filter((status) => status === 201).length, 60);
        assert.equal(results.at(-1), 429);
        assert.equal((await push(base, sealToken(key, `${fcmToken}-other`))).status, 201);
    });
});

test('health check and unknown paths', async () => {
    await withGateway({ fcm: fakeFcm() }, async (base) => {
        assert.equal((await fetch(`${base}/healthz`)).status, 200);
        assert.equal((await fetch(`${base}/`)).status, 404);
    });
});

test('TTL and urgency headers', () => {
    assert.equal(parseTtl('60'), 60);
    assert.equal(parseTtl('0'), 0);
    assert.equal(parseTtl(undefined), 86400);
    assert.equal(parseTtl('-5'), 86400);
    assert.equal(parseTtl('99999999'), 2419200);
    assert.equal(isUrgent(undefined), true);
    assert.equal(isUrgent('high'), true);
    assert.equal(isUrgent('normal'), true);
    assert.equal(isUrgent('Very-Low'), false);
    assert.equal(isUrgent('low'), false);
});
