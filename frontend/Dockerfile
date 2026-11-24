FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.mts tsconfig.json tailwind.config.ts postcss.config.mjs ./
COPY scripts ./scripts
COPY src ./src
COPY public ./public
ARG BUILD=dev
ENV BUILD=${BUILD}
RUN npm run build

FROM alpine:3.20
COPY --from=build /app/dist /dist
COPY publish-pages.sh /publish-pages.sh
CMD ["/bin/sh", "/publish-pages.sh"]
