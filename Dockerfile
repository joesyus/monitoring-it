FROM node:20-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
COPY data ./data
ENV NODE_ENV=production PORT=8080 TZ=Asia/Bangkok
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.js"]
