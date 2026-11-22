/**
 * HTTP side of the gateway.
 *
 *   POST /register   { "fcm_token": "..." }  ->  201 { "endpoint": "https://.../push/<id>" }
 *   POST /push/<id>  encrypted Web Push body ->  201, forwarded to FCM as { webpush: <base64> }
 *   GET  /healthz                             ->  200
 *
 * The push body stays encrypted (RFC 8291), the gateway cannot read it. Nothing is stored
 * and nothing about tokens, endpoints or addresses is logged.
 */
import { openToken, sealToken } from './endpoint.js';
import { RateLimiter } from './rate-limit.js';

/** RFC 8030 allows 4096 bytes of push body. */
const MAX_PUSH_BYTES = 4096;
/** FCM takes at most 4096 bytes of data per message: base64 of the body plus the key. */
const MAX_FCM_DATA_CHARS = 4000;
const MAX_REGISTER_BYTES = 2048;
/** FCM keeps a message for at most 28 days. */
const MAX_TTL_SECONDS = 2419200;
const DEFAULT_TTL_SECONDS = 86400;
const FCM_TOKEN_PATTERN = /^[A-Za-z0-9_:-]{20,1024}$/;

class HttpError extends Error {
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}

/** Reads the request body, at most `limit` bytes. */
function readBody(request, limit) {
    return new Promise((resolve, reject) => {
        const declared = Number(request.headers['content-length']);
        if (declared > limit) {
            reject(new HttpError(413, 'too_large'));
            return;
        }
        const chunks = [];
        let size = 0;
        const collect = (chunk) => {
            size += chunk.length;
            if (size > limit) {
                // Drop the rest unread; the answer closes the connection
                request.off('data', collect);
                request.resume();
                reject(new HttpError(413, 'too_large'));
                return;
            }
            chunks.push(chunk);
        };
        request.on('data', collect);
        request.on('end', () => resolve(Buffer.concat(chunks)));
        request.on('error', reject);
    });
}

/** TTL header of the push (seconds), clamped to what FCM keeps. */
export function parseTtl(header) {
    const ttl = Number.parseInt(header ?? '', 10);
    if (!Number.isFinite(ttl) || ttl < 0) {
        return DEFAULT_TTL_SECONDS;
    }
    return Math.min(ttl, MAX_TTL_SECONDS);
}

/** Urgency header (RFC 8030): very-low and low wait for the device, the rest wakes it. */
export function isUrgent(header) {
    return !['very-low', 'low'].includes(String(header ?? '').trim().toLowerCase());
}

/**
 * @param {Object} options
 * @param {Buffer} options.key gateway key
 * @param {string} options.publicUrl base URL of the gateway, e.g. https://push.example.org
 * @param {ReturnType<import('./fcm.js').createFcmClient>} options.fcm
 * @param {boolean} [options.trustProxy] take the client address from X-Forwarded-For
 * @param {() => number} [options.now]
 * @param {(message: string) => void} [options.log]
 */
export function createGateway({ key, publicUrl, fcm, trustProxy = false, now = Date.now, log = () => {} }) {
    const base = publicUrl.replace(/\/+$/, '');
    // An app registers once per connection and start; a whole NAT shares one address
    const registerLimit = new RateLimiter({ capacity: 30, perSecond: 30 / 600, now });
    // A busy channel with highlights, but no flood
    const pushLimit = new RateLimiter({ capacity: 60, perSecond: 1, now });

    function clientAddress(request) {
        if (trustProxy) {
            // The proxy appends the address it saw, so the last entry is the trusted one
            const forwarded = String(request.headers['x-forwarded-for'] ?? '').split(',').map((part) => part.trim()).filter(Boolean);
            if (forwarded.length) {
                return forwarded[forwarded.length - 1];
            }
        }
        return request.socket.remoteAddress ?? 'unknown';
    }

    function send(response, status, body = null, headers = {}) {
        const payload = body === null ? '' : JSON.stringify(body);
        response.writeHead(status, {
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            ...(body === null ? {} : { 'content-type': 'application/json' }),
            ...headers,
        });
        response.end(payload);
    }

    const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '86400',
    };

    async function register(request, response) {
        if (request.method === 'OPTIONS') {
            send(response, 204, null, cors);
            return;
        }
        if (request.method !== 'POST') {
            send(response, 405, { error: 'method_not_allowed' }, { ...cors, allow: 'POST, OPTIONS' });
            return;
        }
        const wait = registerLimit.take(clientAddress(request));
        if (wait) {
            send(response, 429, { error: 'rate_limited' }, { ...cors, 'retry-after': String(wait) });
            return;
        }
        let input;
        try {
            input = JSON.parse((await readBody(request, MAX_REGISTER_BYTES)).toString('utf8'));
        } catch (error) {
            if (error instanceof HttpError) {
                throw Object.assign(error, { headers: cors });
            }
            send(response, 400, { error: 'invalid_json' }, cors);
            return;
        }
        const token = input?.fcm_token;
        if (typeof token !== 'string' || !FCM_TOKEN_PATTERN.test(token)) {
            send(response, 422, { error: 'invalid_token' }, cors);
            return;
        }
        // Only tokens of this Firebase project get an endpoint
        const check = await fcm.validate(token);
        if (check.status === 'unregistered' || check.status === 'rejected') {
            send(response, 422, { error: 'invalid_token' }, cors);
            return;
        }
        if (check.status !== 'sent') {
            log(`register: FCM check failed (${check.code})`);
            send(response, check.status === 'throttled' ? 503 : 502, { error: 'fcm_unavailable' }, cors);
            return;
        }
        send(response, 201, { endpoint: `${base}/push/${sealToken(key, token)}` }, cors);
    }

    async function push(request, response, id) {
        if (request.method !== 'POST') {
            send(response, 405, null, { allow: 'POST' });
            return;
        }
        const token = openToken(key, id);
        if (!token) {
            send(response, 404);
            return;
        }
        const wait = pushLimit.take(token);
        if (wait) {
            send(response, 429, null, { 'retry-after': String(wait) });
            return;
        }
        if (String(request.headers['content-encoding'] ?? '').trim().toLowerCase() !== 'aes128gcm') {
            send(response, 415);
            return;
        }
        const body = await readBody(request, MAX_PUSH_BYTES);
        if (body.length === 0) {
            send(response, 400);
            return;
        }
        if (Math.ceil(body.length / 3) * 4 + 'webpush'.length > MAX_FCM_DATA_CHARS) {
            send(response, 413);
            return;
        }
        const result = await fcm.send(token, body, {
            ttl: parseTtl(request.headers.ttl),
            urgent: isUrgent(request.headers.urgency),
        });
        switch (result.status) {
            case 'sent':
                send(response, 201);
                break;
            case 'unregistered':
                // The app was removed or its token renewed: the IRC server drops the subscription
                send(response, 410);
                break;
            case 'throttled':
                send(response, 429, null, { 'retry-after': String(result.retryAfter) });
                break;
            case 'rejected':
                log(`push: FCM rejected the message (${result.code})`);
                send(response, 400);
                break;
            default:
                log(`push: FCM failed (${result.code})`);
                send(response, 502);
        }
    }

    async function handle(request, response) {
        const path = new URL(request.url ?? '/', 'http://gateway').pathname;
        try {
            if (path === '/register') {
                await register(request, response);
            } else if (path.startsWith('/push/')) {
                await push(request, response, path.slice('/push/'.length));
            } else if (path === '/healthz' && (request.method === 'GET' || request.method === 'HEAD')) {
                send(response, 200, { ok: true });
            } else {
                send(response, 404, { error: 'not_found' });
            }
        } catch (error) {
            if (response.headersSent) {
                response.destroy();
            } else if (error instanceof HttpError) {
                send(response, error.status, { error: error.code }, { ...(error.headers ?? {}), connection: 'close' });
            } else {
                log(`internal error: ${error?.message ?? error}`);
                send(response, 500, { error: 'internal' });
            }
        }
    }

    return {
        handle,
        prune() {
            registerLimit.prune();
            pushLimit.prune();
        },
    };
}
