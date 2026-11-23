# StarChat push gateway

Forwards Web Push from IRC servers to Firebase Cloud Messaging (FCM), so the StarChat apps get notifications on any network that supports [`draft/webpush`](https://github.com/ircv3/ircv3-specifications/pull/471), for example [Ergo](https://ergo.chat).

Apps cannot receive Web Push directly, they need FCM. A network can relay to FCM itself (feature `push` in the [StarChat docs](https://getstarchat.net/docs/features.html#push)), but only for apps of the Firebase project whose key it holds. This gateway holds the key of the StarChat project, so the StarChat app gets pushes from every network.

## How it works

1. The app gets an FCM token, creates its own Web Push keys and sends the token to `POST /register`.
2. The gateway checks with FCM that the token belongs to its project and answers with an endpoint URL. The URL contains the token, encrypted with the gateway key.
3. The chat registers this endpoint and the app's keys with the IRC server (`WEBPUSH REGISTER`).
4. The IRC server sends encrypted pushes (RFC 8291, `aes128gcm`) to the endpoint. The gateway decrypts the endpoint id back to the token and sends the body as FCM data message `{ "webpush": "<base64>" }`.
5. The app decrypts the push with its keys and shows it.

The gateway cannot read the pushes and stores nothing: no database, no token list. It logs no tokens, endpoints or addresses, only failures of FCM with their error code.

## API

### `POST /register`

```json
{ "fcm_token": "..." }
```

| Status | Body | Meaning |
|--------|------|---------|
| `201` | `{ "endpoint": "https://push.example.org/push/<id>" }` | Endpoint for `WEBPUSH REGISTER`. Every call gives a new one. |
| `400` | `{ "error": "invalid_json" }` | |
| `413` | `{ "error": "too_large" }` | Body over 2048 bytes. |
| `422` | `{ "error": "invalid_token" }` | Not a token of this Firebase project. |
| `429` | `{ "error": "rate_limited" }` | 30 registrations per 10 minutes and address. `Retry-After` says when. |
| `502`, `503` | `{ "error": "fcm_unavailable" }` | FCM could not check the token, try again later. |

Answers carry `Access-Control-Allow-Origin: *`, so the app can call it from its web view. There is nothing to unregister: when the app deletes its FCM token, the next push answers `404` and the IRC server drops the subscription.

### `POST /push/<id>`

Called by the IRC server, as described in RFC 8030. Needs `Content-Encoding: aes128gcm`. `TTL` (default one day, at most 28 days) and `Urgency` (`very-low` and `low` become FCM priority `normal`, the rest `high`) are passed on.

| Status | Meaning |
|--------|---------|
| `201` | Handed to FCM. |
| `400` | Empty body, or FCM refused the message. |
| `404` | Unknown endpoint, for example after the gateway key changed, or FCM no longer knows the token. The IRC server should drop the subscription. RFC 8030 also allows `410` here, but Ergo drops a subscription only on `404`. |
| `413` | Body over 4096 bytes, or too large for FCM: FCM takes 4096 bytes of data, so the body may have at most 2994 bytes. |
| `415` | Not `aes128gcm`. |
| `429` | More than 60 pushes in a burst to one device (one per second after that), or FCM quota. `Retry-After` says when. |
| `502` | FCM failed. |

### `GET /healthz`

`200` while the process runs.

## Running

Needs Node.js 22, no packages.

| Variable | Required | Meaning |
|----------|----------|---------|
| `PUBLIC_URL` | yes | Base URL the gateway is reached at, `https://`. Endpoints are `<PUBLIC_URL>/push/<id>`. |
| `GATEWAY_KEY` | yes | 32 random bytes, base64: `openssl rand -base64 32`. Changing it invalidates every endpoint; the apps register again on their next connect. |
| `FCM_SERVICE_ACCOUNT_FILE` | no | Path of the service account key, `/run/secrets/fcm-service-account.json` by default. |
| `FCM_SERVICE_ACCOUNT` | no | The key as JSON, instead of the file. |
| `PORT` | no | `8080` by default. |
| `TRUST_PROXY` | no | `true` behind a reverse proxy: the client address for the rate limit then comes from the last entry of `X-Forwarded-For`. Only set it when the proxy sets that header, otherwise clients can choose their address. |

```
PUBLIC_URL=http://localhost:8080 GATEWAY_KEY=$(openssl rand -base64 32) \
FCM_SERVICE_ACCOUNT_FILE=secrets/fcm-service-account.json npm start
npm test
```

### Firebase

1. In the Firebase console of the project the apps use: Project settings, Service accounts, Generate new private key.
2. Store the file as `secrets/fcm-service-account.json` next to the compose file. Never commit it; `.gitignore` excludes `secrets/` and `*service-account*.json`.

The key can send to every install of the project's apps. If it leaks, delete it in the Google Cloud console (IAM, Service accounts, Keys) and create a new one.

### Docker

The workflow in `.github/workflows/docker.yml` builds `ghcr.io/starchat-irc/push-gateway` for amd64 and arm64: `edge` from `main`, `latest` and the version from tags `v*`. `compose.example.yml` shows a deployment behind Traefik:

```
cp compose.example.yml compose.yml   # host, network, certificate resolver
echo "GATEWAY_KEY=$(openssl rand -base64 32)" > .env
docker compose up -d
```

The container runs as user `node` with a read-only file system.

## License

[MIT](LICENSE)
