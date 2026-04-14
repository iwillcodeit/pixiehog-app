FROM node:18-slim

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@latest --activate

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile --prod && pnpm remove @shopify/cli

COPY . .

# Generate Prisma client (doesn't need DATABASE_URL, only the schema)
RUN pnpm prisma generate

RUN pnpm run build

CMD ["pnpm", "run", "docker-start"]
