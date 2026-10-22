# build context is the repo root (compose: context: ., dockerfile: api/Dockerfile)

FROM rust:1-bookworm AS build
ARG CARGO_BUILD_JOBS=1
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS} \
    CARGO_INCREMENTAL=0
WORKDIR /src

COPY Cargo.toml Cargo.lock ./
COPY video/Cargo.toml video/Cargo.toml
COPY api/Cargo.toml api/Cargo.toml

RUN mkdir -p video/src api/src \
 && echo 'fn main() {}' > video/src/main.rs \
 && echo 'fn main() {}' > api/src/main.rs \
 && cargo build --release --locked -p api

COPY api/src api/src
RUN touch api/src/main.rs \
 && cargo build --release --locked -p api

FROM debian:bookworm-slim
# /data is for `api monitor` (its one json file). owned by app here, so the named volume
# compose mounts there starts out writable by it
RUN useradd -r -u 10001 -s /usr/sbin/nologin app && mkdir /data && chown app:app /data
COPY --from=build /src/target/release/api /usr/local/bin/api
# the commit this was built from, reported by /api/health. set by deploy.sh; "dev" by hand.
ARG BUILD=dev
ENV BUILD=${BUILD}
USER app
EXPOSE 4000/tcp
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/4000 && printf 'GET /api/health HTTP/1.0\\r\\n\\r\\n' >&3 && head -n1 <&3 | grep -q ' 200 '"]
ENTRYPOINT ["/usr/local/bin/api"]
