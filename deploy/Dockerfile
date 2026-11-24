FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node shared ./shared
COPY --chown=node:node server ./server
USER node
EXPOSE 8787
CMD ["node", "server/index.cjs"]
