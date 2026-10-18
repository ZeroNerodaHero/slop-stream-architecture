# build the pages with node, serve them with caddy. no node needed on the machine.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.mts tsconfig.json tailwind.config.ts postcss.config.mjs ./
COPY src ./src
RUN npm run build

FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
