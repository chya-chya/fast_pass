FROM grafana/k6:1.4.2 AS k6-bin

# Keep only the k6 binary from Grafana's image. The original runtime layer had
# stale Alpine/OpenSSL packages, so the runner uses a fresh Node Alpine base
# and upgrades its runtime packages before application dependencies are added.
FROM node:22-alpine

USER root
COPY --from=k6-bin /usr/bin/k6 /usr/bin/k6

RUN apk upgrade --no-cache \
    && apk add --no-cache bash aws-cli jq procps ca-certificates curl \
    && apk add --no-cache --virtual .build-deps python3 make g++ \
    && curl --fail --silent --show-error --location \
      https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
      --output /etc/ssl/certs/aws-rds-global-bundle.pem \
    && test "$(wc -c </etc/ssl/certs/aws-rds-global-bundle.pem)" -gt 1000

WORKDIR /app
COPY k6/remote/package.json k6/remote/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm rebuild bcrypt \
    && npm cache clean --force \
    && apk del .build-deps

COPY k6 ./k6
COPY docs/performance ./docs/performance

RUN addgroup -g 10001 fastpass \
    && adduser -D -u 10001 -G fastpass fastpass \
    && mkdir -p /app/k6/results \
    && chown -R fastpass:fastpass /app/k6/results

ENV NODE_ENV=load-test
USER 10001:10001
ENTRYPOINT ["node", "k6/tools/remote-agent.mjs"]
