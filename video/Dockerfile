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
 && cargo build --release --locked -p video

COPY video/src video/src
RUN touch video/src/main.rs \
 && cargo build --release --locked -p video

FROM debian:bookworm-slim
RUN useradd -r -u 10001 -s /usr/sbin/nologin app
COPY --from=mwader/static-ffmpeg:7.1 /ffmpeg /usr/local/bin/ffmpeg
COPY --from=build /src/target/release/video /usr/local/bin/video
ARG BUILD=dev
ENV BUILD=${BUILD}
USER app
EXPOSE 7880/tcp
EXPOSE 7882/udp
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/7880 && printf 'GET /health HTTP/1.0\\r\\n\\r\\n' >&3 && grep -q ' 200 ' <&3"]
ENTRYPOINT ["/usr/local/bin/video"]
