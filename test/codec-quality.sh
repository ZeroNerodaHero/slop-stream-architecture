#!/bin/sh
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${WORK:-$(mktemp -d)}
SECONDS_LONG=${SECONDS_LONG:-8}
RATES=${RATES:-"1000 1250 1500 1750 2000 2500"}
GIFS=${GIFS:-"1595422127462 tower the-endless-anomalocaris"}
CLIPS=${CLIPS:-}

ffmpeg -y -loglevel error -f lavfi -i "testsrc2=s=1920x1080:r=30" -t "$SECONDS_LONG" -pix_fmt yuv420p "$WORK/pattern.y4m"
for gif in $GIFS; do
  ffmpeg -y -loglevel error -stream_loop -1 -i "$ROOT/random-media/gifs/$gif.gif" -t "$SECONDS_LONG" -vf "scale=1920:1080:flags=bicubic,fps=30,format=yuv420p" "$WORK/$gif.y4m"
done

encode() {
  src=$1 codec=$2 kbps=$3 out=$4
  if [ "$codec" = vp8 ]; then
    ffmpeg -y -loglevel error -i "$src" -c:v libvpx -deadline realtime -cpu-used 6 -lag-in-frames 0 -error-resilient 1 -b:v "${kbps}k" -maxrate "${kbps}k" -bufsize "${kbps}k" -g 3000 -threads 4 "$out"
  else
    ffmpeg -y -loglevel error -i "$src" -c:v libvpx-vp9 -deadline realtime -cpu-used 7 -row-mt 1 -tile-columns 2 -lag-in-frames 0 -error-resilient 1 -b:v "${kbps}k" -maxrate "${kbps}k" -bufsize "${kbps}k" -g 3000 -threads 4 "$out"
  fi
}

printf 'source codec target_kbps actual_kbps psnr_db ssim\n'
NAMES="pattern $GIFS"
for clip in $CLIPS; do
  name=$(basename "$clip" .y4m)
  ffmpeg -y -loglevel error -i "$clip" -t "$SECONDS_LONG" -vf "scale=1920:1080:flags=bicubic,fps=30,format=yuv420p" "$WORK/$name.y4m"
  NAMES="$NAMES $name"
done

for name in $NAMES; do
  for codec in vp8 vp9; do
    for kbps in $RATES; do
      out="$WORK/$name-$codec-$kbps.webm"
      encode "$WORK/$name.y4m" "$codec" "$kbps" "$out"
      bytes=$(ffprobe -v error -select_streams v:0 -show_entries format=size -of csv=p=0 "$out")
      duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out")
      actual=$(awk -v b="$bytes" -v d="$duration" 'BEGIN { printf "%d", b * 8 / d / 1000 }')
      scores=$(ffmpeg -i "$out" -i "$WORK/$name.y4m" -lavfi "[0:v][1:v]psnr;[0:v][1:v]ssim" -f null - 2>&1)
      psnr=$(printf '%s\n' "$scores" | sed -n 's/.*PSNR.*average:\([0-9.inf]*\).*/\1/p' | tail -n 1)
      ssim=$(printf '%s\n' "$scores" | sed -n 's/.*SSIM.*All:\([0-9.]*\).*/\1/p' | tail -n 1)
      printf '%s %s %s %s %s %s\n' "$name" "$codec" "$kbps" "$actual" "$psnr" "$ssim"
    done
  done
done
