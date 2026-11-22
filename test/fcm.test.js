import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createFcmClient, parseServiceAccount, signedAssertion } from '../src/fcm.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const account = {
    project_id: 'starchat-test',
    client_email: 'gateway@starchat-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
};

/** fetch stand-in: answers from a list and records the requests. */
function fakeFetch(answers) {
    const requests = [];
    const fetchImpl = async (url, init) => {
        requests.push({ url, ...init });
        if (url === 'https://oauth2.googleapis.com/token') {
            return Response.json({ access_token: `access-${requests.length}`, expires_in: 3600 });
        }
        const answer = answers.shift() ?? { status: 200, body: { name: 'projects/x/messages/1' } };
        if (answer.throws) {
            throw answer.throws;
        }
        return Response.json(answer.body ?? {}, { status: answer.status, headers: answer.headers });
    };
    return { fetchImpl, requests };
}

const fcmError = (status, errorCode) => ({
    status,
    body: { error: { code: status, details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }] } },
});

test('the service account needs project, email and key', () => {
    assert.equal(parseServiceAccount(JSON.stringify(account)).project_id, 'starchat-test');
    assert.throws(() => parseServiceAccount('{'), /not valid JSON/);
    assert.throws(() => parseServiceAccount(JSON.stringify({ ...account, private_key: '' })), /private_key/);
});

test('the OAuth assertion is a JWT signed with the service account key', () => {
    const [header, payload, signature] = signedAssertion(account, 1000).split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    assert.deepEqual(claims, {
        iss: account.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat: 1000,
        exp: 4600,
    });
    const valid = createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature, 'base64url'));
    assert.equal(valid, true);
});

test('a push goes to FCM v1 as data message, the access token is reused', async () => {
    const { fetchImpl, requests } = fakeFetch([]);
    const fcm = createFcmClient({ account, fetchImpl });
    assert.deepEqual(await fcm.send('token-1', Buffer.from([1, 2, 3]), { ttl: 60, urgent: true }), { status: 'sent' });
    assert.deepEqual(await fcm.send('token-2', Buffer.from([4]), { ttl: 0, urgent: false }), { status: 'sent' });

    assert.equal(requests.filter((request) => request.url.includes('oauth2')).length, 1);
    const sent = requests.filter((request) => request.url.includes('fcm.googleapis.com'));
    assert.equal(sent[0].url, 'https://fcm.googleapis.com/v1/projects/starchat-test/messages:send');
    assert.equal(sent[0].headers.authorization, 'Bearer access-1');
    assert.deepEqual(JSON.parse(sent[0].body), {
        message: { token: 'token-1', data: { webpush: 'AQID' }, android: { priority: 'high', ttl: '60s' } },
    });
    assert.deepEqual(JSON.parse(sent[1].body).message.android, { priority: 'normal', ttl: '0s' });
});

test('an expired access token is renewed', async () => {
    let time = 0;
    const { fetchImpl, requests } = fakeFetch([]);
    const fcm = createFcmClient({ account, fetchImpl, now: () => time });
    await fcm.send('t', Buffer.from([1]), { ttl: 1, urgent: true });
    time = 3600 * 1000;
    await fcm.send('t', Buffer.from([1]), { ttl: 1, urgent: true });
    assert.equal(requests.filter((request) => request.url.includes('oauth2')).length, 2);
});

test('a 401 from FCM fetches a new access token once', async () => {
    const { fetchImpl, requests } = fakeFetch([{ status: 401 }]);
    const fcm = createFcmClient({ account, fetchImpl });
    assert.deepEqual(await fcm.send('t', Buffer.from([1]), { ttl: 1, urgent: true }), { status: 'sent' });
    assert.equal(requests.filter((request) => request.url.includes('oauth2')).length, 2);
});

test('FCM errors are sorted into what the IRC server has to know', async () => {
    const cases = [
        [fcmError(404, 'UNREGISTERED'), { status: 'unregistered', code: 'UNREGISTERED' }],
        [fcmError(403, 'SENDER_ID_MISMATCH'), { status: 'unregistered', code: 'SENDER_ID_MISMATCH' }],
        [{ ...fcmError(429, 'QUOTA_EXCEEDED'), headers: { 'retry-after': '30' } }, { status: 'throttled', retryAfter: 30, code: 'QUOTA_EXCEEDED' }],
        [fcmError(400, 'INVALID_ARGUMENT'), { status: 'rejected', code: 'INVALID_ARGUMENT' }],
        [fcmError(503, 'UNAVAILABLE'), { status: 'failed', code: 'UNAVAILABLE' }],
        [{ throws: new TypeError('fetch failed') }, { status: 'failed', code: 'network' }],
    ];
    for (const [answer, expected] of cases) {
        const { fetchImpl } = fakeFetch([answer]);
        const fcm = createFcmClient({ account, fetchImpl });
        assert.deepEqual(await fcm.send('t', Buffer.from([1]), { ttl: 1, urgent: true }), expected);
    }
});

test('a refused service account is reported as such, not as a network failure', async () => {
    const fetchImpl = async (url) => url.includes('oauth2')
        ? Response.json({ error: 'invalid_grant' }, { status: 400 })
        : Response.json({});
    const fcm = createFcmClient({ account, fetchImpl });
    assert.deepEqual(await fcm.send('t', Buffer.from([1]), { ttl: 1, urgent: true }), { status: 'failed', code: 'oauth' });
});

test('validate asks FCM without delivering', async () => {
    const { fetchImpl, requests } = fakeFetch([]);
    const fcm = createFcmClient({ account, fetchImpl });
    assert.deepEqual(await fcm.validate('token-1'), { status: 'sent' });
    const body = JSON.parse(requests.at(-1).body);
    assert.equal(body.validate_only, true);
    assert.equal(body.message.token, 'token-1');
});
