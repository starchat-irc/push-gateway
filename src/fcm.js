/**
 * Client for the FCM HTTP v1 API with a service account, without the Google SDKs.
 *
 * The access token comes from a JWT signed with the service account key (OAuth 2.0 JWT
 * bearer grant) and is reused until shortly before it expires.
 */
import { createSign } from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REQUEST_TIMEOUT_MS = 10000;

/**
 * @param {string} json content of the service account key file
 * @returns {{project_id: string, client_email: string, private_key: string}}
 */
export function parseServiceAccount(json) {
    let account;
    try {
        account = JSON.parse(json);
    } catch {
        throw new Error('The FCM service account is not valid JSON');
    }
    for (const field of ['project_id', 'client_email', 'private_key']) {
        if (typeof account?.[field] !== 'string' || account[field] === '') {
            throw new Error(`The FCM service account has no ${field}`);
        }
    }
    return account;
}

/**
 * @param {{client_email: string, private_key: string}} account
 * @param {number} nowSeconds
 */
export function signedAssertion(account, nowSeconds) {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
        iss: account.client_email,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: nowSeconds,
        exp: nowSeconds + 3600,
    })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(account.private_key).toString('base64url');
    return `${unsigned}.${signature}`;
}

/** The errorCode of an FCM error response, if any. */
function fcmErrorCode(body) {
    const details = body?.error?.details;
    if (!Array.isArray(details)) {
        return null;
    }
    return details.find((detail) => typeof detail?.errorCode === 'string')?.errorCode ?? null;
}

/**
 * @param {Object} options
 * @param {{project_id: string, client_email: string, private_key: string}} options.account
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now] milliseconds
 */
export function createFcmClient({ account, fetchImpl = fetch, now = Date.now }) {
    const sendUrl = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`;
    let cached = null;

    async function accessToken() {
        if (cached && cached.expires > now()) {
            return cached.token;
        }
        const assertion = signedAssertion(account, Math.floor(now() / 1000));
        const response = await fetchImpl(TOKEN_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || typeof body.access_token !== 'string') {
            throw new Error(`OAuth token request failed with ${response.status}`);
        }
        const lifetime = Number(body.expires_in) > 0 ? Number(body.expires_in) : 3600;
        // Renew a minute early, so a token never expires on the way to FCM
        cached = { token: body.access_token, expires: now() + (lifetime - 60) * 1000 };
        return cached.token;
    }

    /**
     * @returns {Promise<{status: 'sent'|'unregistered'|'rejected'|'throttled'|'failed', retryAfter?: number, code?: string}>}
     */
    async function post(message) {
        for (let attempt = 0; attempt < 2; attempt++) {
            let token;
            try {
                token = await accessToken();
            } catch {
                return { status: 'failed', code: 'oauth' };
            }
            let response;
            try {
                response = await fetchImpl(sendUrl, {
                    method: 'POST',
                    headers: {
                        authorization: `Bearer ${token}`,
                        'content-type': 'application/json',
                    },
                    body: JSON.stringify(message),
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                });
            } catch (error) {
                return { status: 'failed', code: error?.name === 'TimeoutError' ? 'timeout' : 'network' };
            }
            if (response.ok) {
                return { status: 'sent' };
            }
            if (response.status === 401 && attempt === 0) {
                // Revoked or expired early: fetch a new access token once
                cached = null;
                continue;
            }
            const body = await response.json().catch(() => ({}));
            const code = fcmErrorCode(body);
            if (response.status === 404 || code === 'UNREGISTERED' || code === 'SENDER_ID_MISMATCH') {
                return { status: 'unregistered', code: code ?? 'NOT_FOUND' };
            }
            if (response.status === 429 || code === 'QUOTA_EXCEEDED') {
                const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
                return { status: 'throttled', retryAfter: retryAfter > 0 ? retryAfter : 60, code: code ?? 'QUOTA_EXCEEDED' };
            }
            if (response.status === 400) {
                return { status: 'rejected', code: code ?? 'INVALID_ARGUMENT' };
            }
            return { status: 'failed', code: code ?? String(response.status) };
        }
        return { status: 'failed', code: 'UNAUTHENTICATED' };
    }

    return {
        /**
         * Sends an encrypted Web Push body as data message { webpush: <base64> }.
         *
         * @param {string} token
         * @param {Buffer} body
         * @param {{ttl: number, urgent: boolean}} options
         */
        send(token, body, { ttl, urgent }) {
            return post({
                message: {
                    token,
                    data: { webpush: body.toString('base64') },
                    android: { priority: urgent ? 'high' : 'normal', ttl: `${ttl}s` },
                },
            });
        },

        /** Asks FCM whether the token belongs to this project, without delivering anything. */
        validate(token) {
            return post({ validate_only: true, message: { token, data: { check: '1' } } });
        },
    };
}
