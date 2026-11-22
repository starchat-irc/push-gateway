# No dependencies: the image only needs Node and the sources.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY package.json ./
COPY src ./src

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "src/index.js"]
