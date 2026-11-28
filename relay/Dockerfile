FROM rust:1-bookworm AS build
ARG CARGO_BUILD_JOBS=1
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS} \
    CARGO_INCREMENTAL=0
WORKDIR /src

COPY relay/Cargo.toml relay/Cargo.lock ./
RUN mkdir src \
 && echo 'fn main() {}' > src/main.rs \
 && cargo build --release --locked

COPY relay/src src
RUN touch src/main.rs \
 && cargo build --release --locked

FROM debian:bookworm-slim
RUN useradd -r -u 10001 -s /usr/sbin/nologin app
COPY --from=mwader/static-ffmpeg:7.1 /ffmpeg /usr/local/bin/ffmpeg
COPY --from=bluenviron/mediamtx:1.21.4 /mediamtx /usr/local/bin/mediamtx
COPY --from=build /src/target/release/relay /usr/local/bin/relay
ARG BUILD=dev
ENV BUILD=${BUILD} \
    FFMPEG=/usr/local/bin/ffmpeg \
    MEDIAMTX=/usr/local/bin/mediamtx \
    MEDIAMTX_CONFIG=/tmp/mediamtx.yml
USER app
EXPOSE 8889/tcp
EXPOSE 8189/udp
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/9998 && printf 'GET /health HTTP/1.0\\r\\n\\r\\n' >&3 && head -n1 <&3 | grep -q ' 200 '"]
ENTRYPOINT ["/usr/local/bin/relay"]
