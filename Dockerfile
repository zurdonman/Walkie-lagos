# Walkie Lagos — imagen mínima de producción
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0
WORKDIR /app

# Usuario sin privilegios
RUN addgroup -g 1001 walkie && adduser -D -u 1001 -G walkie walkie

COPY --from=deps --chown=walkie:walkie /app/node_modules ./node_modules
COPY --chown=walkie:walkie package.json server.js ./
COPY --chown=walkie:walkie lib ./lib
COPY --chown=walkie:walkie public ./public
COPY --chown=walkie:walkie config.json ./

USER walkie
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=4s --start-period=8s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
