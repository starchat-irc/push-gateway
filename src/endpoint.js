/**
 * Endpoint ids: the FCM token, encrypted with the gateway key (AES-256-GCM).
 *
 * The gateway keeps no database. The endpoint URL itself carries the token, and only the
 * gateway can read it. Every registration gets a new id (random IV), so ids of the same
 * device cannot be linked. The first byte is a version, so the format can change later.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const ID_PATTERN = /^[A-Za-z0-9_-]{40,1500}$/;

/**
 * @param {string} text 32 bytes, base64 encoded (openssl rand -base64 32)
 * @returns {Buffer}
 */
export function parseKey(text) {
    const key = Buffer.from(String(text ?? '').trim(), 'base64');
    if (key.length !== 32) {
        throw new Error('GATEWAY_KEY must be 32 bytes, base64 encoded. Create one with: openssl rand -base64 32');
    }
    return key;
}

/**
 * @param {Buffer} key
 * @param {string} token FCM registration token
 * @returns {string} base64url id for the endpoint URL
 */
export function sealToken(key, token) {
    const version = Buffer.from([VERSION]);
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(version);
    const sealed = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return Buffer.concat([version, iv, sealed, cipher.getAuthTag()]).toString('base64url');
}

/**
 * @param {Buffer} key
 * @param {string} id
 * @returns {string|null} the FCM token, or null for ids this gateway did not create
 */
export function openToken(key, id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
        return null;
    }
    const data = Buffer.from(id, 'base64url');
    if (data.length <= 1 + IV_LENGTH + TAG_LENGTH || data[0] !== VERSION) {
        return null;
    }
    try {
        const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(1, 1 + IV_LENGTH));
        decipher.setAAD(data.subarray(0, 1));
        decipher.setAuthTag(data.subarray(data.length - TAG_LENGTH));
        const token = Buffer.concat([
            decipher.update(data.subarray(1 + IV_LENGTH, data.length - TAG_LENGTH)),
            decipher.final(),
        ]);
        return token.toString('utf8');
    } catch {
        return null;
    }
}
