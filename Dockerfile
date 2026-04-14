FROM node:18-slim

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@latest --activate

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY extensions/web-pixel/package.json ./extensions/web-pixel/

RUN pnpm install --frozen-lockfile

COPY . .

# Generate Prisma client (doesn't need DATABASE_URL, only the schema)
RUN pnpm prisma generate

RUN pnpm run build

# Remove dev dependencies after build
ENV CI=true
RUN pnpm prune --prod

CMD ["pnpm", "run", "docker-start"]
