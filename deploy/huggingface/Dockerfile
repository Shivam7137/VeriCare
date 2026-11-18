# VeriCare hosted demo: Postgres, the API, the worker and the web app in one container.
# Built for a Hugging Face Docker Space (runs as uid 1000, serves port 7860).
# Every record is fictional and the database starts fresh on every boot.
FROM node:24-bookworm-slim AS node

FROM postgres:17-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
  && useradd -m -u 1000 user \
  && install -d -o user -g user /home/user/app

USER user
ENV HOME=/home/user \
  NEXT_TELEMETRY_DISABLED=1 \
  PORT=7860
WORKDIR /home/user/app

COPY --chown=user package.json package-lock.json ./
COPY --chown=user apps/api/package.json apps/api/
COPY --chown=user apps/web/package.json apps/web/
COPY --chown=user packages/contracts/package.json packages/contracts/
RUN npm ci --no-audit --no-fund

COPY --chown=user . .
RUN sed -i 's/\r$//' deploy/huggingface/start.sh && npm run build

EXPOSE 7860
CMD ["bash", "deploy/huggingface/start.sh"]
