FROM node:22-alpine
RUN apk add --no-cache openssl

WORKDIR /app
EXPOSE 3000

COPY package.json package-lock.json ./
COPY extensions/cartlift-discount/package.json extensions/cartlift-discount/package.json
COPY extensions/cartlift-pixel/package.json extensions/cartlift-pixel/package.json

# Dev dependencies are needed for the build (vite, react-router dev), then pruned.
RUN npm ci --ignore-scripts && npm cache clean --force

COPY . .

RUN npx prisma generate && npm run build && npm prune --omit=dev

ENV NODE_ENV=production
CMD ["npm", "run", "docker-start"]
