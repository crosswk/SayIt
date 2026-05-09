FROM node:20-alpine

WORKDIR /app/gateway

COPY gateway/package*.json ./
RUN npm ci --omit=dev

COPY gateway /app/gateway

CMD ["node", "proxy.mjs"]
