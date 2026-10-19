# stage 1: build the react pages with node. no node needed on the machine.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.mts tsconfig.json tailwind.config.ts postcss.config.mjs ./
COPY src ./src
# the commit, from deploy.sh. vite bakes it in as __BUILD__; every error report carries it.
ARG BUILD=dev
ENV BUILD=${BUILD}
RUN npm run build

# stage 2: a tiny image whose only job is to copy the built pages into the volume
# caddy serves from. it runs once per deploy. caddy itself never restarts, so the
# websockets of people who are live stay up while the pages change under them.
FROM alpine:3.20
COPY --from=build /app/dist /dist
COPY publish-pages.sh /publish-pages.sh
CMD ["/bin/sh", "/publish-pages.sh"]
