# build context is the repo root (compose: context: ., dockerfile: video/Dockerfile)

FROM rust:1-bookworm AS build
# 1 keeps memory low on a small vps. deploy.sh raises it on bigger machines.
ARG CARGO_BUILD_JOBS=1
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS} \
    CARGO_INCREMENTAL=0
WORKDIR /src

# manifests first so the dependency build is cached until a Cargo.toml changes
COPY Cargo.toml Cargo.lock ./
COPY video/Cargo.toml video/Cargo.toml
COPY api/Cargo.toml api/Cargo.toml

# every workspace member needs a target to exist, even when only building video
RUN mkdir -p video/src api/src \
 && echo 'fn main() {}' > video/src/main.rs \
 && echo 'fn main() {}' > api/src/main.rs \
 && cargo build --release --locked -p video

# real source. touch so cargo notices it is newer than the dummy build
COPY video/src video/src
RUN touch video/src/main.rs \
 && cargo build --release --locked -p video

FROM debian:bookworm-slim
RUN useradd -r -u 10001 -s /usr/sbin/nologin app
# ffmpeg makes the thumbnails (one small process per live stream). static build, no libs needed.
COPY --from=mwader/static-ffmpeg:7.1 /ffmpeg /usr/local/bin/ffmpeg
COPY --from=build /src/target/release/video /usr/local/bin/video
USER app
EXPOSE 7880/tcp
EXPOSE 7882/udp
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/7880"]
ENTRYPOINT ["/usr/local/bin/video"]
