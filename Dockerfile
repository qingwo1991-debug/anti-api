# syntax=docker/dockerfile:1
FROM oven/bun:1.1.38

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

COPY . .

ENV NODE_ENV=production
ENV HOME=/app/data

RUN mkdir -p /app/data

EXPOSE 8964 51121

CMD ["bun", "run", "src/main.ts", "start"]
