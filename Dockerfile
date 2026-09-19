FROM node:22-alpine
RUN apk add --no-cache openssl

WORKDIR /app
EXPOSE 3000

COPY package.json package-lock.json ./

# Root workspace only: the extensions are built and deployed by the Shopify CLI,
# not by this server. Dev dependencies are needed for the build, then pruned.
RUN npm ci --ignore-scripts --workspaces=false --no-audit --no-fund && npm cache clean --force

COPY . .

RUN npx prisma generate && npm run build && npm prune --omit=dev --workspaces=false --no-audit --no-fund

ENV NODE_ENV=production
CMD ["npm", "run", "docker-start"]
