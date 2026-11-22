# NaukriSetu job portal — one container. Data (database, banners, uploads) lives in /data, a Docker volume
# that survives restarts, rebuilds and updates.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates fontconfig fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
RUN mkdir -p /data /backups && chown -R node:node /data /backups
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/robots.txt').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["tini", "--"]
CMD ["node", "src/server.js"]
