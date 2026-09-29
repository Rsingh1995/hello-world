FROM node:22-alpine
WORKDIR /app
COPY . .
ENV PORT=3000 HOST=0.0.0.0 DATA_DIR=/data NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 3000
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
