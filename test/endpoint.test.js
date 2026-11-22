import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openToken, parseKey, sealToken } from '../src/endpoint.js';

const key = randomBytes(32);
const token = 'dGVzdC10b2tlbg:APA91bHun4MxP5egoKMwt2KZFBaFUH-1RYqx';

test('a sealed token opens again with the same key', () => {
    const id = sealToken(key, token);
    assert.match(id, /^[A-Za-z0-9_-]+$/);
    assert.equal(openToken(key, id), token);
});

test('the id does not show the token and differs on every registration', () => {
    const first = sealToken(key, token);
    const second = sealToken(key, token);
    assert.notEqual(first, second);
    assert.ok(!Buffer.from(first, 'base64url').toString('latin1').includes('APA91'));
});

test('ids of another key, changed ids and garbage are refused', () => {
    const id = sealToken(key, token);
    assert.equal(openToken(randomBytes(32), id), null);

    const bytes = Buffer.from(id, 'base64url');
    bytes[20] ^= 1;
    assert.equal(openToken(key, bytes.toString('base64url')), null);

    const otherVersion = Buffer.from(id, 'base64url');
    otherVersion[0] = 2;
    assert.equal(openToken(key, otherVersion.toString('base64url')), null);

    assert.equal(openToken(key, 'short'), null);
    assert.equal(openToken(key, `${id}/../x`), null);
    assert.equal(openToken(key, undefined), null);
});

test('the gateway key must be 32 bytes in base64', () => {
    assert.equal(parseKey(key.toString('base64')).length, 32);
    assert.throws(() => parseKey(''), /GATEWAY_KEY/);
    assert.throws(() => parseKey(randomBytes(16).toString('base64')), /GATEWAY_KEY/);
});
