#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
: "${FFMPEG:?the ffmpeg to relay with, e.g. the one in mwader/static-ffmpeg:7.1}"
: "${MEDIAMTX:?the mediamtx binary}"
export FFMPEG
export ICE_IP="${ICE_IP:-$(ip -4 -o addr show scope global | awk 'NR==1 {sub(/\/.*/, "", $4); print $4}')}"
[ -f tls.key ] || openssl req -x509 -newkey rsa:2048 -nodes -keyout tls.key -out tls.crt -days 2 -subj /CN=localhost 2>/dev/null
python3 -c "import os; print(os.path.expandvars(open('mediamtx.yml').read()))" > .mediamtx.yml
"$MEDIAMTX" .mediamtx.yml > mediamtx.log 2>&1 &
mtx=$!
python3 -m http.server 8765 --bind 127.0.0.1 > /dev/null 2>&1 &
web=$!
trap 'kill $mtx $web 2>/dev/null' EXIT
sleep 2
python3 publish.py "${SECS:-30}" &
pub=$!
sleep 15
ffprobe -v error -show_entries stream=codec_name,profile,width,height,sample_rate,channels -of compact rtmp://127.0.0.1:1935/sink
timeout 25 ffmpeg -hide_banner -loglevel error -y -i rtmp://127.0.0.1:1935/sink -t 10 -c copy sink.mp4
ffprobe -v error -show_entries format=duration:stream=codec_name,nb_frames -of compact sink.mp4
wait $pub
