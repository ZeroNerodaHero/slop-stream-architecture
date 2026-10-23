#!/usr/bin/env bash
#
# deploy.sh — bring the stream lab up on this machine, or redeploy part of it.
#
#   ./deploy.sh                   everything. first time, or any time
#   ./deploy.sh 203.0.113.7       everything, with this ip
#   ./deploy.sh api               rebuild and restart only the api
#   ./deploy.sh frontend video    only these (frontend, api, video, dummy)
#   ./deploy.sh --pull            git pull, then rebuild only what the pull changed
#   ./deploy.sh --pull api        git pull, then only the api
#   ./deploy.sh --prune-deploy    first give the disk back what the builds took (docker's build
#                                 cache, untagged images), then deploy as asked. for the small box
#                                 that says "only 2664MB free". goes with --pull and services
#   ./deploy.sh --images TAG      no build on this machine: start the images ./ship.sh built on a
#                                 laptop and sent here (--to) or pushed to a registry (IMAGES= in
#                                 .env). goes with --pull and services. a 1 GB box can run this
#   ./deploy.sh passwd billy      a new password for an account (there is no email reset)
#   PUBLIC_IP=10.0.0.5 ./deploy.sh
#
# Full run, Linux (Ubuntu 22.04/24.04, Debian 12): installs docker if missing,
# refuses if 80/443 are taken, adds a 2G swapfile on small boxes, opens ufw
# ports, writes .env (PUBLIC_IP, CARGO_BUILD_JOBS, and ENV_NAME = this machine's
# hostname unless you set one), builds the pages and the three rust images (api,
# video, dummy) one at a time, starts everything, waits for /api/health. Exits
# non-zero if the health check fails. The images carry BUILD (the commit), so a
# full deploy restarts video whenever HEAD moved since the last one: every live
# stream ends, and the script says so before `up`. macOS (Docker Desktop): same,
# minus install / swap / ufw; PUBLIC_IP comes from en0/en1 (no ipify lookup).
#
# Partial run: keeps PUBLIC_IP from .env, rebuilds the named services, swaps
# only their containers. frontend = the pages; caddy keeps running, so live
# streams survive. api = a few seconds of 502, streams survive. video = every
# live stream ends (the script says so first). Afterwards the swapped containers
# are checked: running, healthy where the image has a check, or the script exits
# non-zero (no rollback).
#
# Every run that ends well writes the commit it deployed to .deployed (gitignored).
# --pull diffs from there, not from HEAD, so a --pull that died in a build is
# picked up whole by the next one instead of reporting "nothing changed".
#
# Stop everything later with:  docker compose down
#
set -euo pipefail

# ---- knobs -------------------------------------------------------------------
ENV_FILE=".env"
DEPLOYED_FILE=".deployed"                 # the commit the last run that ended well deployed
HEALTH_PATH="/api/health"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"   # seconds
TCP_PORTS="80 443"                        # keep in sync with docker-compose.yml
UDP_PORTS="7882"
MIN_RAM_MB=2048                           # less than this and no swap -> add a swapfile
BIG_RAM_MB=3500                           # at least this -> let cargo use every core
SWAP_FILE="/swapfile"
SWAP_SIZE_MB=2048

# ---- helpers -----------------------------------------------------------------
say()  { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\nWARN: %s\n' "$*" >&2; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

case "$(uname -s)" in
  Linux)  OS=linux ;;
  Darwin) OS=mac ;;
  *)      die "unsupported OS: $(uname -s)" ;;
esac

is_root()  { [ "$(id -u)" -eq 0 ]; }
can_root() { is_root || have sudo; }
as_root() {
  if is_root; then "$@"
  elif have sudo; then sudo "$@"
  else die "need root or sudo for: $*"
  fi
}

DOCKER=(docker)   # becomes (sudo docker) if the user can't reach the socket

is_ipv4() {
  local ip="$1" re='^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$' octet IFS='.'
  [[ $ip =~ $re ]] || return 1
  for octet in $ip; do
    [ "$octet" -le 255 ] || return 1
  done
}

mem_mb() {
  if [ "$OS" = linux ]; then
    awk '/^MemTotal:/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0
  else
    echo $(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1024 / 1024 ))
  fi
}

cpu_count() {
  if [ "$OS" = linux ]; then nproc 2>/dev/null || echo 1
  else sysctl -n hw.ncpu 2>/dev/null || echo 1
  fi
}

swap_mb() {   # linux only; 0 elsewhere
  [ "$OS" = linux ] || { echo 0; return 0; }
  awk '/^SwapTotal:/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0
}

# ---- 1. PUBLIC_IP ------------------------------------------------------------
env_file_value() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^[[:space:]]*$1=//p" "$ENV_FILE" | tail -n 1 | tr -d "\"' \t\r"
}

# KEY=VALUE into .env: the existing line replaced in place, else appended. nothing else moves.
set_env_key() {
  local key="$1" value="$2" tmp; tmp="$(mktemp)"
  [ -f "$ENV_FILE" ] || : > "$ENV_FILE"
  awk -v k="$key" -v v="$value" '
    $0 ~ "^[[:space:]]*" k "=" { if (!seen) { print k "=" v; seen = 1 }; next }
    { print }
    END { if (!seen) print k "=" v }
  ' "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}

# the compose image name of a service, the way docker-compose.yml spells it:
# ${IMAGES:-}stream-<service>:${TAG:-latest}. local builds: stream-video:latest.
image_name() { printf '%sstream-%s:%s' "${IMAGES:-}" "$1" "${TAG:-latest}"; }

lan_ip() {   # linux: the address the default route leaves from, else nothing
  [ "$OS" = linux ] && have ip || return 0
  ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}' || true
}

detect_ip() {   # sets DETECTED_IP / DETECTED_VIA
  DETECTED_IP=""; DETECTED_VIA=""
  local c="" iface
  if [ "$OS" = linux ]; then
    c="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || true)"
    if is_ipv4 "$c"; then DETECTED_IP="$c"; DETECTED_VIA="public ip via api.ipify.org"; fi
    if [ -z "$DETECTED_IP" ]; then
      c="$(lan_ip)"
      if is_ipv4 "$c"; then DETECTED_IP="$c"; DETECTED_VIA="lan ip via ip route"; fi
    fi
    if [ -z "$DETECTED_IP" ]; then
      c="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
      if is_ipv4 "$c"; then DETECTED_IP="$c"; DETECTED_VIA="lan ip via hostname -I"; fi
    fi
  else
    for iface in en0 en1; do
      c="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
      if is_ipv4 "$c"; then DETECTED_IP="$c"; DETECTED_VIA="lan ip on $iface"; break; fi
    done
  fi
  if [ -z "$DETECTED_IP" ]; then DETECTED_IP="127.0.0.1"; DETECTED_VIA="fallback, nothing detected"; fi
}

pick_public_ip() {
  local from_file; from_file="$(env_file_value PUBLIC_IP)"
  if [ -n "${1:-}" ]; then
    PUBLIC_IP="$1"; IP_SOURCE="argument"
  elif [ -n "${PUBLIC_IP:-}" ]; then
    IP_SOURCE="PUBLIC_IP environment variable"
  elif [ -n "$from_file" ] && [ "$from_file" != "127.0.0.1" ]; then
    PUBLIC_IP="$from_file"; IP_SOURCE="existing $ENV_FILE"
  else
    detect_ip
    PUBLIC_IP="$DETECTED_IP"; IP_SOURCE="auto-detected: $DETECTED_VIA"
  fi
  is_ipv4 "$PUBLIC_IP" || die "PUBLIC_IP '$PUBLIC_IP' ($IP_SOURCE) is not an IPv4 address. Try: ./deploy.sh 1.2.3.4"
  export PUBLIC_IP
  say "PUBLIC_IP = $PUBLIC_IP   ($IP_SOURCE)"
  note "override:  ./deploy.sh 1.2.3.4     or     PUBLIC_IP=1.2.3.4 ./deploy.sh"
  note "testing on your own lan? use this machine's lan ip, not 127.0.0.1 and not the router's public ip."
  if [ "$PUBLIC_IP" = "127.0.0.1" ]; then
    warn "127.0.0.1 only works for a browser on this exact machine, and video may not connect. prefer the lan ip."
  fi
  # an old .env can outlive a cloud ip change
  if [ "$IP_SOURCE" = "existing $ENV_FILE" ]; then
    detect_ip
    if [ "$DETECTED_IP" != "$PUBLIC_IP" ] && [ "$DETECTED_IP" != "127.0.0.1" ]; then
      warn "$ENV_FILE says $PUBLIC_IP but this machine looks like $DETECTED_IP ($DETECTED_VIA). ip changed? run: ./deploy.sh $DETECTED_IP"
    fi
  fi
  # a public ip that is not on any interface is right behind cloud 1:1 nat, wrong on a
  # home lan: ipify answers with the router's address there, video advertises it, and
  # every watcher on the lan gets a black picture while /api/health says fine. the cloud
  # is the target, so the pick stands; but say it loud, with the way out.
  if [ "$OS" = linux ] && have ip && ! ip -4 -o addr 2>/dev/null | grep -q " $PUBLIC_IP/"; then
    local lan; lan="$(lan_ip)"
    if is_ipv4 "$lan" && [ "$lan" != "$PUBLIC_IP" ]; then
      warn "$PUBLIC_IP is not on any interface of this machine; its lan ip is $lan."
      note "cloud vm behind 1:1 nat (aws, gcp): $PUBLIC_IP is right, carry on."
      note "home or office lan: $PUBLIC_IP is the router. video stays black for everyone. switch with:  ./deploy.sh $lan"
    else
      note "$PUBLIC_IP is not on a local interface. fine on a cloud vm (1:1 nat). on a home lan use the lan ip."
    fi
  fi
}

# ---- 2. docker ---------------------------------------------------------------
wait_for_apt() {
  have fuser || return 0
  local n=0
  while as_root fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock >/dev/null 2>&1; do
    if [ "$n" -eq 0 ]; then note "waiting for another apt/dpkg process to finish (first-boot updates?)"; fi
    n=$((n + 1))
    if [ "$n" -ge 60 ]; then warn "apt still locked after 5 minutes; trying anyway"; break; fi
    sleep 5
  done
}

apt_install() {
  wait_for_apt
  as_root apt-get -o DPkg::Lock::Timeout=300 update -qq
  as_root env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y -qq "$@"
}

ensure_curl() {
  if have curl; then return 0; fi
  [ "$OS" = linux ] || die "curl not found. Install it and re-run."
  say "curl not found, installing it"
  if   have apt-get; then apt_install curl ca-certificates
  elif have dnf;     then as_root dnf install -y curl
  elif have yum;     then as_root yum install -y curl
  else die "curl not found and no known package manager. Install curl and re-run."
  fi
}

ensure_docker() {
  if have docker; then return 0; fi
  if [ "$OS" = mac ]; then
    cat >&2 <<'EOF'

ERROR: docker not found. Install Docker Desktop for Mac, start it, then re-run ./deploy.sh
  https://docs.docker.com/desktop/setup/install/mac-install/
  or:  brew install --cask docker
EOF
    exit 1
  fi
  say "docker not found, installing with https://get.docker.com (needs root or sudo)"
  can_root || die "docker is not installed and there is no root/sudo to install it."
  if have apt-get; then wait_for_apt; fi
  curl -fsSL https://get.docker.com | as_root sh
  if have systemctl; then
    as_root systemctl enable --now docker || warn "could not enable docker via systemd; start it by hand"
  elif have service; then
    as_root service docker start || true
  fi
  if ! is_root; then
    as_root usermod -aG docker "$(id -un)"
    note "added $(id -un) to the 'docker' group. That takes effect after you log out and back in;"
    note "until then docker needs sudo (this script handles that for this run)."
  fi
}

pick_docker_cmd() {   # sets DOCKER
  DOCKER=(docker)
  if docker info >/dev/null 2>&1; then
    check_credential_helper
    return 0
  fi
  if [ "$OS" = mac ]; then
    die "docker is installed but the daemon isn't reachable. Start Docker Desktop and re-run."
  fi
  if ! is_root && have sudo && sudo docker info >/dev/null 2>&1; then
    DOCKER=(sudo docker)
    note "using 'sudo docker' (your user can't reach /var/run/docker.sock yet; re-login fixes that)"
    keep_sudo_alive
    return 0
  fi
  die "can't reach the docker daemon. Is it running?   (systemctl status docker)"
}

# Docker Desktop's credential helper sometimes hangs (keychain prompt). Then
# every image pull stalls forever with no message. Catch it before the build.
check_credential_helper() {
  [ "$OS" = mac ] || return 0
  have docker-credential-desktop || return 0
  grep -q '"credsStore"' "${DOCKER_CONFIG:-$HOME/.docker}/config.json" 2>/dev/null || return 0
  if ! perl -e 'alarm 10; exec @ARGV' docker-credential-desktop list </dev/null >/dev/null 2>&1; then
    warn "docker-credential-desktop is not answering, so image pulls will hang."
    note "fix: restart Docker Desktop, answer its keychain prompt, or remove \"credsStore\" from ~/.docker/config.json"
    die "fix the credential helper and re-run"
  fi
}

# Builds take longer than sudo's timestamp. Refresh it in the background.
keep_sudo_alive() {
  sudo -v || die "sudo is needed for docker"
  ( while kill -0 $$ 2>/dev/null; do sudo -n true 2>/dev/null; sleep 60; done ) &
}

ensure_compose() {
  if "${DOCKER[@]}" compose version >/dev/null 2>&1; then return 0; fi
  if [ "$OS" = linux ] && have apt-get; then
    say "'docker compose' (v2 plugin) missing, installing docker-compose-plugin"
    apt_install docker-compose-plugin || apt_install docker-compose-v2 || true
  fi
  "${DOCKER[@]}" compose version >/dev/null 2>&1 \
    || die "'docker compose' v2 is not available (the old 'docker-compose' v1 won't do). See https://docs.docker.com/compose/install/linux/"
}

# ---- 3. ports and disk free? -------------------------------------------------
check_ports() {
  local p holders
  for p in $TCP_PORTS; do
    if [ "$OS" = mac ]; then
      holders="$(lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $1}' | sort -u | tr '\n' ' ' || true)"
    else
      have ss || return 0
      holders="$(as_root ss -ltnpH "sport = :$p" 2>/dev/null | awk '$NF ~ /^users:/ {print $NF}' | sort -u | tr '\n' ' ' || true)"
    fi
    if [ -n "$holders" ] && ! printf '%s' "$holders" | grep -Eqi 'docker|com\.docke'; then
      die "port $p/tcp is already used by: $holders
  Stop it first, e.g.:  sudo systemctl disable --now nginx apache2"
    fi
  done
}

free_mb_here() { df -Pm . 2>/dev/null | awk 'NR==2 {print $4}' || echo 0; }

check_disk() {
  local free_mb need=4000 total
  free_mb="$(free_mb_here)"
  if [ "${IMAGES_MODE:-0}" = 1 ]; then
    # no build here: the four images are ~800 MB to pull, and docker wants room to unpack them
    [ "${free_mb:-0}" -ge 1500 ] || die "only ${free_mb}MB free here; pulling the images needs about 1.5 GB. try: ./deploy.sh --prune-deploy ${ORIGINAL_ARGS[*]:-}"
    return 0
  fi
  # ensure_swap is about to dd a swapfile, most likely out of this same disk
  total="$(mem_mb)"
  if [ "$OS" = linux ] && [ ! -e "$SWAP_FILE" ] && [ "${total:-0}" -lt "$MIN_RAM_MB" ] && [ "$(swap_mb)" -eq 0 ]; then
    need=$(( need + SWAP_SIZE_MB ))
  fi
  if [ "${free_mb:-0}" -lt "$need" ]; then
    if [ "${PRUNE:-0}" = 1 ]; then
      die "only ${free_mb}MB free here (${need}MB is the floor), even after the prune. the rust images need about 6-8GB to build. grow the disk, or look at what else is on it: docker system df -v; du -sh /var/lib/docker/containers/*/*-json.log"
    fi
    die "only ${free_mb}MB free here (${need}MB is the floor). the rust images need about 6-8GB to build.
  try:  ./deploy.sh --prune-deploy ${ORIGINAL_ARGS[*]:-}   (drops docker's build cache and untagged images first, usually several GB)
  or grow the disk."
  fi
  if [ "${free_mb:-0}" -lt 10000 ]; then
    warn "${free_mb}MB free is tight. the rust builds use about 6-8GB while compiling."
  fi
}

# ---- 3b. prune (--prune-deploy) ------------------------------------------------
# give the disk back what the builds took, then deploy as asked. the build cache is the
# big one: buildkit keeps every cargo target dir it ever made, and a box that compiled
# a few times holds 10GB+ of them. untagged images are the small one. nothing that
# holds data goes: no volumes, no containers, no tagged images, not the swapfile (the
# build needs it on a small box). the build cache belongs to docker, not to this
# project, so every project's goes; each one comes back on its next build.
prune_for_deploy() {
  local before after old
  before="$(free_mb_here)"
  say "giving the disk back what the builds took (--prune-deploy). ${before}MB free now"
  note "build cache:      $("${DOCKER[@]}" builder prune -af 2>&1 | tail -n 1 || echo "could not prune it")"
  note "untagged images:  $("${DOCKER[@]}" image prune -f 2>&1 | tail -n 1 || echo "could not prune them")"
  # our own images from earlier ships or builds (stream-x:<old tag>) that no container runs
  old="$(comm -23 <("${DOCKER[@]}" images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E '^([^/]+/)*stream-[a-z]+:' | sort -u) \
                 <("${DOCKER[@]}" ps -a --format '{{.Image}}' 2>/dev/null | sort -u) || true)"
  if [ -n "$old" ]; then
    # shellcheck disable=SC2086
    "${DOCKER[@]}" rmi $old >/dev/null 2>&1 || true
    note "old stream images: $(echo "$old" | wc -l | tr -d ' ') removed ($(echo "$old" | tr '\n' ' '))"
  fi
  after="$(free_mb_here)"
  note "${after}MB free, $(( after - before ))MB back. the next build of every project compiles from scratch"
}

# ---- 4. swap -----------------------------------------------------------------
ensure_swap() {
  [ "$OS" = linux ] || return 0
  [ "${IMAGES_MODE:-0}" = 0 ] || return 0   # swap is for the rust build; nothing is built here
  local total swap
  total="$(mem_mb)"
  swap="$(swap_mb)"
  if [ "${total:-0}" -ge "$MIN_RAM_MB" ] || [ "${swap:-0}" -gt 0 ]; then return 0; fi
  say "${total:-?}MB RAM and no swap. adding a ${SWAP_SIZE_MB}MB swapfile so the rust build doesn't get killed"
  if ! can_root; then warn "no root/sudo; skipping swap. The build may run out of memory."; return 0; fi
  if [ ! -e "$SWAP_FILE" ]; then
    # dd, not fallocate: btrfs and old xfs refuse fallocated swapfiles
    as_root touch "$SWAP_FILE"
    as_root chattr +C "$SWAP_FILE" 2>/dev/null || true
    as_root dd if=/dev/zero of="$SWAP_FILE" bs=1M count="$SWAP_SIZE_MB" status=none
    as_root chmod 600 "$SWAP_FILE"
    as_root mkswap "$SWAP_FILE" >/dev/null
  fi
  if as_root swapon "$SWAP_FILE" 2>/dev/null; then
    note "swap is on for this session only (not in /etc/fstab; gone after reboot)."
    note "remove it now with:  sudo swapoff $SWAP_FILE && sudo rm $SWAP_FILE"
  else
    warn "swapon $SWAP_FILE failed (container/VPS without swap support?). Continuing without swap."
    as_root rm -f "$SWAP_FILE"
  fi
}

# ---- 5. firewall -------------------------------------------------------------
open_firewall() {
  local p ufw_out=""
  if [ "$OS" = linux ] && have ufw && can_root; then
    ufw_out="$(as_root ufw status 2>/dev/null || true)"
  fi
  case "$ufw_out" in
  "Status: active"*)
    say "ufw is active, adding the ports the site needs"
    # docker publishes ports through its own iptables chain, ahead of ufw's rules, so
    # these are reachable either way. the rules make `ufw status` tell the truth.
    for p in $TCP_PORTS; do as_root ufw allow "$p/tcp" >/dev/null; note "ufw allow $p/tcp"; done
    for p in $UDP_PORTS; do as_root ufw allow "$p/udp" >/dev/null; note "ufw allow $p/udp"; done
    note "(docker-published ports bypass ufw anyway; this keeps 'ufw status' honest, it is not what opens them)"
    ;;
  esac
  say "firewall reminder"
  note "If this is a cloud machine, the provider firewall must ALSO allow inbound:"
  note "  tcp ${TCP_PORTS// /, }     (the site)"
  note "  udp ${UDP_PORTS// /, }         (the video itself. without it the page loads but video stays black)"
  note "AWS: security group.  GCP: VPC firewall rule.  Hetzner / DigitalOcean / Vultr: the cloud firewall on the server."
}

# ---- 6. .env -----------------------------------------------------------------
write_env() {
  local tmp; tmp="$(mktemp)"
  if [ -f "$ENV_FILE" ]; then
    awk -v ip="$PUBLIC_IP" -v jobs="$CARGO_BUILD_JOBS" '
      /^[[:space:]]*PUBLIC_IP=/        { if (!seen_ip)   { print "PUBLIC_IP=" ip;          seen_ip = 1 };   next }
      /^[[:space:]]*CARGO_BUILD_JOBS=/ { if (!seen_jobs) { print "CARGO_BUILD_JOBS=" jobs; seen_jobs = 1 }; next }
      { print }
      END {
        if (!seen_ip)   print "PUBLIC_IP=" ip
        if (!seen_jobs) print "CARGO_BUILD_JOBS=" jobs
      }
    ' "$ENV_FILE" > "$tmp"
  else
    printf 'PUBLIC_IP=%s\nCARGO_BUILD_JOBS=%s\n' "$PUBLIC_IP" "$CARGO_BUILD_JOBS" > "$tmp"
  fi
  cat "$tmp" > "$ENV_FILE"   # keeps owner/mode; avoids `sed -i` (GNU vs BSD)
  rm -f "$tmp"
  say "wrote PUBLIC_IP=$PUBLIC_IP and CARGO_BUILD_JOBS=$CARGO_BUILD_JOBS to $ENV_FILE"
  sync_env_keys
}

# New knobs arrive in .env.example with a pull (DUMMY_*, ENV_NAME, ADMIN_NAMES, ...).
# Append the ones this .env does not have yet, comments and default included, so
# they are there to find and edit. Lines already in .env are never touched.
sync_env_keys() {
  [ -f .env.example ] && [ -f "$ENV_FILE" ] || return 0
  local tmp added; tmp="$(mktemp)"
  awk -v envfile="$ENV_FILE" '
    BEGIN {
      while ((getline l < envfile) > 0)
        if (l ~ /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=/) { sub(/^[[:space:]]*/, "", l); sub(/=.*/, "", l); have[l] = 1 }
      close(envfile)
      have["PUBLIC_IP"] = 1; have["CARGO_BUILD_JOBS"] = 1   # write_env owns these two
    }
    /^[[:space:]]*$/ { block = ""; next }
    /^#/ { block = block $0 "\n"; next }
    /^[A-Za-z_][A-Za-z0-9_]*=/ {
      k = $0; sub(/=.*/, "", k)
      if (!(k in have)) { printf "\n%s%s\n", block, $0; have[k] = 1 }
      block = ""
    }
  ' .env.example > "$tmp"
  if [ -s "$tmp" ]; then
    added="$(grep -o '^[A-Za-z_][A-Za-z0-9_]*=' "$tmp" | tr -d '=' | tr '\n' ' ')"
    cat "$tmp" >> "$ENV_FILE"
    note "added to $ENV_FILE with their defaults (edit when you want): $added"
  fi
  rm -f "$tmp"
}

# a pull may bring new knobs in .env.example and a first ENV_NAME; land them even
# when nothing needs a rebuild. no .env yet: nothing to land in, a full deploy writes it.
refresh_env() {
  [ -f "$ENV_FILE" ] || return 0
  sync_env_keys
  pick_env_name
}

# ---- 6b. ENV_NAME --------------------------------------------------------------
# what this box calls itself in /api/health and in every stored error. empty or
# missing in .env: this machine's hostname goes in, once (lowercase, a-z 0-9 -, 32
# chars at most). a value already in .env is never touched; ENV_NAME in the shell
# only seeds an empty one. an empty value left by hand makes the api say "unnamed".
pick_env_name() {
  local in_file; in_file="$(env_file_value ENV_NAME)"
  if [ -n "$in_file" ]; then
    if [ -n "${ENV_NAME:-}" ] && [ "$ENV_NAME" != "$in_file" ]; then
      note "ENV_NAME=$ENV_NAME in the shell, but $ENV_FILE says $in_file and wins. edit the file to change it."
    fi
    ENV_NAME="$in_file"; export ENV_NAME
    return 0
  fi
  local via="ENV_NAME from the shell"
  if [ -z "${ENV_NAME:-}" ]; then
    ENV_NAME="$(hostname -s 2>/dev/null || uname -n 2>/dev/null || true)"
    ENV_NAME="$(printf '%s' "${ENV_NAME%%.*}" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-' | cut -c1-32)"
    via="this machine's hostname"
  fi
  if [ -z "$ENV_NAME" ]; then
    warn "no hostname to use as ENV_NAME; the api will call this box 'unnamed'. set ENV_NAME in $ENV_FILE"
    return 0
  fi
  local tmp; tmp="$(mktemp)"
  if [ -f "$ENV_FILE" ]; then
    awk -v name="$ENV_NAME" '
      /^[[:space:]]*ENV_NAME=/ { if (!seen) { print "ENV_NAME=" name; seen = 1 }; next }
      { print }
      END { if (!seen) print "ENV_NAME=" name }
    ' "$ENV_FILE" > "$tmp"
  else
    printf 'ENV_NAME=%s\n' "$ENV_NAME" > "$tmp"
  fi
  cat "$tmp" > "$ENV_FILE"   # keeps owner/mode, like write_env
  rm -f "$tmp"
  export ENV_NAME
  say "wrote ENV_NAME=$ENV_NAME to $ENV_FILE ($via. prefer prod, dev, ...? edit that line)"
}

# one rust compile job wants about 1.5GB. never more jobs than cores.
pick_build_jobs() {
  if [ -n "${CARGO_BUILD_JOBS:-}" ]; then export CARGO_BUILD_JOBS; return 0; fi
  local total cpus
  total="$(mem_mb)"
  cpus="$(cpu_count)"
  CARGO_BUILD_JOBS=$(( ${total:-0} / 1500 ))
  [ "$CARGO_BUILD_JOBS" -ge 1 ] || CARGO_BUILD_JOBS=1
  [ "$CARGO_BUILD_JOBS" -le "${cpus:-1}" ] || CARGO_BUILD_JOBS="$cpus"
  export CARGO_BUILD_JOBS
}

# ---- 7. build + start --------------------------------------------------------
# with --images this is a pull instead: the one place every path gets an image from,
# so the full deploy and the partial ones work the same either way.
build_one() {
  if [ "${IMAGES_MODE:-0}" = 1 ]; then
    if [ -z "$IMAGES" ]; then
      # no registry: ./ship.sh --to put the image into docker here. it is there, or it is not.
      "${DOCKER[@]}" image inspect "$(image_name "$1")" >/dev/null 2>&1 && return 0
      die "$(image_name "$1") is not on this machine. on the laptop:  ./ship.sh --to <this box> $1   (it prints the tag; this run asked for $TAG)
  have:  $("${DOCKER[@]}" images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep "^stream-$1:" | tr '\n' ' ' || true)"
    fi
    "${DOCKER[@]}" compose pull "$1" && return 0
    die "pulling $(image_name "$1") failed.
  'not found' / 'manifest unknown': nothing is pushed under tag $TAG yet. the github action builds it after a push to main
      (a few minutes: github.com/<you>/<repo>/actions), or ./ship.sh on the laptop pushes it. is the tag the commit you mean?
  'denied' / 'unauthorized': the package is private. make it public (github.com → your profile → Packages → stream-$1 →
      Package settings → Change visibility), or log this machine in:  gh auth token | ${DOCKER[*]} login ghcr.io -u <you> --password-stdin   (token with read:packages)"
  fi
  # BUILD on the command line as well as exported: `sudo docker` resets the
  # environment, and compose would then bake "dev" while this script prints the sha.
  "${DOCKER[@]}" compose build --build-arg BUILD="${BUILD:-dev}" "$1" && return 0
  die "building $1 failed. 'signal: 9, SIGKILL' in the output means out of memory: add RAM or swap, or set CARGO_BUILD_JOBS=1."
}

# `up -d` builds a service whose image is missing. in images mode a miss must fail
# loudly (wrong TAG), not quietly start a 30-minute compile.
UP_FLAGS=()

compose_up() {
  if [ "${IMAGES_MODE:-0}" = 1 ]; then
    if [ -n "$IMAGES" ]; then say "pulling the images (IMAGES=$IMAGES TAG=$TAG). nothing is built here"
    else say "using the images ./ship.sh sent here (tag $TAG). nothing is built, nothing is pulled"; fi
  else
    say "building the images one at a time (first time: several minutes, CARGO_BUILD_JOBS=$CARGO_BUILD_JOBS, BUILD=$BUILD)"
  fi
  build_one pages
  build_one video
  build_one dummy
  build_one api
  # `up -d` swaps every container whose image changed, video included: that ends
  # every live stream. say so first, the way redeploy_service does.
  local cid running built
  cid="$("${DOCKER[@]}" compose ps -q --status running video 2>/dev/null || true)"
  if [ -n "$cid" ]; then
    running="$("${DOCKER[@]}" inspect -f '{{.Image}}' "$cid" 2>/dev/null || true)"
    built="$("${DOCKER[@]}" image inspect -f '{{.Id}}' "$(image_name video)" 2>/dev/null || true)"
    if [ -n "$built" ] && [ "$running" != "$built" ]; then
      warn "redeploying video ends every live stream right now. watchers reconnect on their own; streamers press start again."
      note "why: the image carries BUILD, so a new commit (or -dirty) is a new video image, and up -d swaps the container."
    fi
  fi
  say "${DOCKER[*]} compose up -d ${UP_FLAGS[*]:-}"
  "${DOCKER[@]}" compose up -d ${UP_FLAGS[@]+"${UP_FLAGS[@]}"}
  # the Caddyfile is a bind mount, so compose never notices it changed. a reload
  # is graceful and free when nothing changed, so always do it.
  "${DOCKER[@]}" compose exec -T frontend caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 \
    || warn "caddy did not reload its Caddyfile; if routes look stale: ${DOCKER[*]} compose restart frontend"
  prune_images
}

# the image a container ran before the swap has no tag now (the new build took it),
# and every deploy leaves one more of those. remove them, and only them: not volumes,
# not tagged images, not the build cache (that one is yours to drop, and it is what
# makes the next build fast).
prune_images() {
  local out
  out="$("${DOCKER[@]}" image prune -f 2>/dev/null | tail -n 1 || true)"
  note "untagged images from earlier builds removed (${out:-nothing to remove}). the build cache stays; ./deploy.sh --prune-deploy drops it first next time"
}

# ---- did the swap take? --------------------------------------------------------
# "<status> <health> <restarts> <exit code>", e.g. "running healthy 0 0", "running
# none 0 0" (no healthcheck), "exited none 0 1". "missing" when there is no such
# container. the names are fixed by container_name in docker-compose.yml.
container_state() {
  "${DOCKER[@]}" inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}} {{.State.ExitCode}}' "$1" 2>/dev/null \
    || echo "missing none 0 1"
}

# a one-shot (pages): wait up to 2 minutes for it to finish. prints its exit code,
# or "running" when it never did.
wait_one_shot() {
  local status health restarts code n=0
  while :; do
    read -r status health restarts code <<< "$(container_state "$1")"
    case "$status" in running|created|restarting) ;; *) echo "$code"; return 0 ;; esac
    if [ "$n" -ge 60 ]; then echo running; return 0; fi
    sleep 2; n=$((n + 1))
  done
}

# wait_for_health proves the api answers, and it answers 200 with video down. so a
# partial run looks at the containers it swapped: running, no restart since we first
# looked, and healthy where the image has a check (api, video, chat, database, redis;
# dummy and caddy have none, so 5s of running is what there is to see). 60s each,
# then exit non-zero. no rollback: the old image lost its tag to the new build, so
# the way back is a fix and another deploy.
check_swapped() {
  local c status health restarts code base settled deadline
  say "checking the swapped containers"
  for c in "$@"; do
    deadline=$(( $(date +%s) + 60 )); base=""; settled=""
    while :; do
      read -r status health restarts code <<< "$(container_state "$c")"
      [ -n "$base" ] || base="$restarts"
      if [ "$status" = running ] && [ "$restarts" = "$base" ] && [ "$health" != unhealthy ]; then
        if [ "$health" = healthy ]; then note "$c: running, healthy"; break; fi
        if [ "$health" = none ]; then
          [ -n "$settled" ] || settled=$(( $(date +%s) + 5 ))
          if [ "$(date +%s)" -ge "$settled" ]; then note "$c: running"; break; fi
        fi
        # health "starting": the check has not spoken yet
      elif [ "$status" != created ]; then
        swap_failed "$c" "$c is $status (health $health, $(( restarts - base )) restart(s) since the swap, exit code $code)"
      fi
      if [ "$(date +%s)" -ge "$deadline" ]; then swap_failed "$c" "$c is still $status / $health after 60s"; fi
      sleep 2
    done
  done
}

swap_failed() {   # service, what happened. prints its log, exits non-zero
  printf '\n'
  "${DOCKER[@]}" compose logs --no-log-prefix --tail 30 "$1" 2>/dev/null || true
  die "redeploy failed: $2. above: the last 30 lines of its log. more: ${DOCKER[*]} compose logs $1"
}

# ---- partial redeploy --------------------------------------------------------
# `frontend` means the pages: rebuild them and run the one-shot copy. caddy is
# left alone, so nobody's websocket drops. the Caddyfile is a bind mount; when it
# changed, caddy reloads it in place.
redeploy_frontend() {
  build_one pages
  say "publishing the new pages (caddy keeps running)"
  "${DOCKER[@]}" compose up -d --no-deps ${UP_FLAGS[@]+"${UP_FLAGS[@]}"} pages
  # the one-shot's exit code is the only word on whether the copy worked (a full
  # disk, say). `compose wait` would hand it over, but is too new for some installs.
  local code; code="$(wait_one_shot pages)"
  "${DOCKER[@]}" compose logs --no-log-prefix --tail 1 pages 2>/dev/null || true
  [ "$code" = 0 ] || swap_failed pages "publishing the pages failed (pages exit code: $code)"
}

reload_caddy() {
  say "Caddyfile changed, reloading caddy in place"
  if ! "${DOCKER[@]}" compose exec -T frontend caddy reload --config /etc/caddy/Caddyfile 2>/dev/null; then
    warn "reload failed, restarting caddy instead (open websockets drop)"
    "${DOCKER[@]}" compose up -d --no-deps --force-recreate frontend
  fi
}

redeploy_service() {   # api | video
  if [ "$1" = video ]; then
    warn "redeploying video ends every live stream right now. watchers reconnect on their own; streamers press start again."
  fi
  build_one "$1"
  if [ "$1" = api ]; then
    # chat is the same image run as `api chat`, so it moves with the api
    say "swapping the api and chat containers"
    "${DOCKER[@]}" compose up -d --no-deps ${UP_FLAGS[@]+"${UP_FLAGS[@]}"} api chat
  else
    say "swapping the $1 container"
    "${DOCKER[@]}" compose up -d --no-deps ${UP_FLAGS[@]+"${UP_FLAGS[@]}"} "$1"
  fi
}

# the fake streams. video and api read the same password, so they are included:
# compose only recreates them if that env actually changed.
redeploy_dummy() {
  build_one dummy
  say "swapping the dummy container (video and api only if DUMMY_PASSWORD changed)"
  "${DOCKER[@]}" compose up -d --no-deps ${UP_FLAGS[@]+"${UP_FLAGS[@]}"} dummy video api
  note "dummy streams: $(env_file_value DUMMY_STREAMS)   (DUMMY_STREAMS in $ENV_FILE)"
}

redeploy_targets() {
  local t
  for t in ${TARGETS[@]+"${TARGETS[@]}"}; do
    case "$t" in
      frontend) redeploy_frontend ;;
      api|video) redeploy_service "$t" ;;
      dummy) redeploy_dummy ;;
      caddy) reload_caddy ;;
      compose) say "docker-compose.yml changed, applying it"; "${DOCKER[@]}" compose up -d ${UP_FLAGS[@]+"${UP_FLAGS[@]}"} ;;
    esac
  done
}

# the long-running containers the targets swapped (or may have), for check_swapped.
# pages is a one-shot and is checked where it runs, in redeploy_frontend.
swapped_containers() {
  local t out=""
  for t in ${TARGETS[@]+"${TARGETS[@]}"}; do
    case "$t" in
      api) out="$out api chat" ;;
      video) out="$out video" ;;
      dummy) out="$out dummy video api" ;;   # video and api only move when DUMMY_PASSWORD changed; checking is free
      caddy) out="$out frontend" ;;
      compose) out="$out frontend api chat database redis video dummy" ;;
    esac
  done
  printf '%s\n' $out | awk 'NF && !seen[$0]++' | tr '\n' ' '
}

# ---- git pull ----------------------------------------------------------------
pull_repo() {   # sets OLD_HEAD NEW_HEAD
  have git || die "git not found"
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "this folder is not a git checkout, nothing to pull"
  git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1 \
    || die "this branch has no upstream to pull from. on your machine: git push -u origin <branch>"
  local head; head="$(git rev-parse HEAD)"
  # diff from the last commit a run deployed in full, not from HEAD: a --pull that died
  # in a build moved HEAD and deployed nothing, and HEAD alone would call the next
  # --pull "nothing changed". DEPLOY_PULLED_FROM: handed over by reexec_if_updated.
  OLD_HEAD="${DEPLOY_PULLED_FROM:-$(last_deployed "$head")}"
  say "git pull --ff-only"
  git pull --ff-only || die "pull failed. local edits in the way? see: git status"
  NEW_HEAD="$(git rev-parse HEAD)"
  if [ "$head" = "$NEW_HEAD" ]; then note "already up to date"; else note "$(git log --oneline "$head..$NEW_HEAD" | wc -l | tr -d ' ') new commit(s)"; fi
  if [ "$OLD_HEAD" != "$head" ]; then
    note "the last run that ended well deployed $(git rev-parse --short "$OLD_HEAD"), not $(git rev-parse --short "$head"): what changed since then counts too"
  fi
}

# the commit in .deployed, when this branch has it; else the fallback given.
last_deployed() {
  local d=""
  [ ! -f "$DEPLOYED_FILE" ] || d="$(tr -d '[:space:]' < "$DEPLOYED_FILE")"
  if [ -n "$d" ] && git merge-base --is-ancestor "$d" HEAD 2>/dev/null; then echo "$d"
  else
    # stderr: callers capture stdout
    [ -z "$d" ] || note "$DEPLOYED_FILE says $d, which is not on this branch; going by HEAD instead" >&2
    echo "$1"
  fi
}

# the commit this run deployed, for the next --pull. only after a run that ended well,
# and only in a git checkout (a tarball has nothing to diff against anyway).
record_deployed() {
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
  git rev-parse HEAD > "$DEPLOYED_FILE" 2>/dev/null || true
}

# The pull may have replaced this very script. bash reads a script while it runs,
# and the new one may know about services this one does not, so hand over to it.
reexec_if_updated() {
  [ -z "${DEPLOY_REEXEC:-}" ] || return 0
  git diff --name-only "$OLD_HEAD" "$NEW_HEAD" | grep -qx deploy.sh || return 0
  say "deploy.sh itself changed in the pull, continuing with the new one"
  DEPLOY_REEXEC=1 DEPLOY_PULLED_FROM="$OLD_HEAD" exec bash ./deploy.sh ${ORIGINAL_ARGS[@]+"${ORIGINAL_ARGS[@]}"}
}

# which services the files changed between two commits belong to, one per line,
# sorted (main puts them in deploy order). docs, tests, monitor/ and this script
# map to nothing: they run somewhere else. .env.example maps to nothing to build,
# its new keys land in .env through refresh_env on every run.
changed_services() {
  git diff --name-only "$1" "$2" | while IFS= read -r f; do
    case "$f" in
      Cargo.toml|Cargo.lock) printf 'api\nvideo\ndummy\n' ;;
      .dockerignore) printf 'api\nvideo\ndummy\n' ;;       # the rust build context is the repo root
      frontend/.dockerignore) echo frontend ;;              # the pages build context is frontend/
      api/*) echo api ;;
      video/*) printf 'video\ndummy\n' ;;
      frontend/Caddyfile) echo caddy ;;
      frontend/*) echo frontend ;;
      docker-compose.yml) echo compose ;;
    esac
  done | sort -u
}

# ---- password reset ------------------------------------------------------------
# `./deploy.sh passwd <name>`: a new random password for an account, printed once,
# every login of that name out. On a name with no account it makes one.
passwd_account() {
  pick_docker_cmd
  [ -n "$("${DOCKER[@]}" compose ps -q api 2>/dev/null)" ] || die "the api container is not up. ./deploy.sh first"
  # RUST_LOG=warn: without it the schema's "already exists, skipping" notices come first
  "${DOCKER[@]}" compose exec -T -e RUST_LOG=warn api api passwd "$1"
}

# ---- args --------------------------------------------------------------------
# bold on a terminal, plain when piped (./deploy.sh --help | less). the escape codes
# take no width, so the columns below are lined up by their visible text.
usage() {
  local B="" N=""
  if [ -t 1 ]; then
    B="$(tput bold 2>/dev/null || printf '\033[1m')"
    N="$(tput sgr0 2>/dev/null || printf '\033[0m')"
  fi
  cat <<EOF
${B}usage:${N} ./deploy.sh [--pull] [--prune-deploy] [--images TAG] [PUBLIC_IP] [frontend|api|video|dummy ...]
       ./deploy.sh passwd <name>

${B}what to deploy${N}
  ${B}(nothing named)${N}           full deploy: machine setup, every image, docker compose up
  ${B}frontend api video dummy${N}  rebuild just these and swap their containers (chat moves with api),
                            then check them: running and healthy, or exit non-zero
  ${B}PUBLIC_IP${N}                 use this ip (full deploy only). otherwise: \$PUBLIC_IP > .env > auto-detect

${B}flags${N}
  ${B}--pull${N}                    git pull --ff-only first. with no services named, redeploy what changed
                            since the last run that ended well (.deployed), so a --pull that
                            failed halfway is retried whole by the next one
  ${B}--prune-deploy${N}            first give the disk back what the builds took, then deploy as asked:
                            docker's build cache (every project's on this machine; each comes
                            back on its next build) and untagged images. for the box that says
                            "only 2664MB free". volumes, containers and the swapfile stay
  ${B}--images TAG${N}              build nothing here: start the images ./ship.sh built on a laptop, TAG
                            being the commit it prints. sent here with ./ship.sh --to <this box>
                            they are already in docker; pushed to a registry they are pulled
                            (IMAGES=ghcr.io/<you>/ in .env or the environment). TAG and IMAGES
                            are written to .env so a plain compose keeps using them. no 4 GB
                            floor, no swapfile: a 1 GB box runs the stack, it just could not build it

${B}other${N}
  ${B}passwd <name>${N}             print a new random password for that account. the only reset there is
  ${B}-h, --help${N}                this

${B}notes${N}
  dummy = the fake streams. set DUMMY_STREAMS and DUMMY_PASSWORD in .env first.
  new knobs from .env.example are appended to .env with their defaults on every run
  (also a --pull that finds nothing to redeploy). passwd touches nothing.
  a full deploy restarts video when HEAD moved since the last one: every live stream ends.
EOF
}

parse_args() {   # sets IP_ARG PULL PRUNE IMAGES_MODE TAG TARGETS PASSWD_NAME
  IP_ARG=""; PULL=0; PRUNE=0; IMAGES_MODE=0; TAG="${TAG:-}"; TARGETS=(); PASSWD_NAME=""
  local a want_name=0 want_tag=0
  for a in "$@"; do
    if [ "$want_name" = 1 ]; then PASSWD_NAME="$a"; want_name=0; continue; fi
    # the word after --images is the tag, unless it is clearly something else (a service, a flag, an ip)
    if [ "$want_tag" = 1 ]; then
      want_tag=0
      case "$a" in
        -*|frontend|api|video|dummy|pages|chat|passwd) ;;
        *) if ! is_ipv4 "$a" && [[ "$a" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then TAG="$a"; continue; fi ;;
      esac
    fi
    case "$a" in
      -h|--help) usage; exit 0 ;;
      --pull) PULL=1 ;;
      --prune-deploy) PRUNE=1 ;;
      --images) IMAGES_MODE=1; want_tag=1 ;;
      --images=*) IMAGES_MODE=1; TAG="${a#--images=}" ;;
      passwd) want_name=1 ;;
      frontend|api|video|dummy) TARGETS+=("$a") ;;
      pages) TARGETS+=("frontend") ;;
      chat) TARGETS+=("api") ;;
      *)
        if is_ipv4 "$a"; then IP_ARG="$a"
        else die "don't know what '$a' is. services are: frontend api video dummy. see ./deploy.sh --help"
        fi ;;
    esac
  done
  if [ "$want_name" = 1 ]; then die "usage: ./deploy.sh passwd <name>"; fi
  if [ -n "$PASSWD_NAME" ] && { [ "$PULL" = 1 ] || [ "$PRUNE" = 1 ] || [ "$IMAGES_MODE" = 1 ] || [ -n "$IP_ARG" ] || [ ${#TARGETS[@]} -gt 0 ]; }; then
    die "passwd goes alone: ./deploy.sh passwd $PASSWD_NAME"
  fi
  if [ -n "$IP_ARG" ] && [ ${#TARGETS[@]} -gt 0 ]; then
    die "changing the ip touches the cert, caddy and video. run a full deploy: ./deploy.sh $IP_ARG"
  fi
}

load_public_ip_from_env() {
  PUBLIC_IP="${PUBLIC_IP:-$(env_file_value PUBLIC_IP)}"
  is_ipv4 "${PUBLIC_IP:-}" || die "no PUBLIC_IP in $ENV_FILE. run a full deploy first: ./deploy.sh"
  export PUBLIC_IP
}

# --images: where the images come from, and which. IMAGES from the environment, else
# .env: a registry prefix (a missing trailing / is added) to pull from, or empty when
# `./ship.sh --to` already put them into docker here. TAG from the command line, else
# the environment, else .env; it has to be known: `latest` is nothing ship.sh --to
# makes, and a guess would start the wrong images. both are exported so compose
# resolves ${IMAGES:-}stream-x:${TAG:-latest} to those names, and written to .env so
# a `docker compose up -d` by hand later starts the same images and not a build.
setup_images_mode() {
  IMAGES="${IMAGES:-$(env_file_value IMAGES)}"
  [ -z "$IMAGES" ] || IMAGES="${IMAGES%/}/"
  # no tag named: the commit this checkout is at, which is what ./ship.sh and the github
  # action tag their images with. after --pull that is the commit just pulled.
  if [ -z "$TAG" ]; then
    TAG="$(git rev-parse --short HEAD 2>/dev/null || true)"
    [ -n "$TAG" ] && note "no tag given: using this checkout's commit, $TAG"
  fi
  [ -n "$TAG" ] || die "--images needs the tag ./ship.sh printed:  ./deploy.sh --images <tag>   (what is here: $("${DOCKER[@]}" images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep '^stream-' | tr '\n' ' ' || true))"
  export IMAGES TAG
  UP_FLAGS=(--no-build)
  set_env_key IMAGES "$IMAGES"
  set_env_key TAG "$TAG"
  if [ -n "$IMAGES" ]; then say "images from $IMAGES, tag $TAG   (written to $ENV_FILE; empty IMAGES and TAG there go back to building here)"
  else say "images sent here by ./ship.sh, tag $TAG   (TAG written to $ENV_FILE; empty there goes back to building here)"; fi
}

# ---- 8. health ---------------------------------------------------------------
http_code() { curl -k -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null || true; }

wait_for_health() {
  local url="https://${PUBLIC_IP}${HEALTH_PATH}" local_url="https://127.0.0.1${HEALTH_PATH}"
  local deadline code local_code
  say "waiting up to ${HEALTH_TIMEOUT}s for ${url} to answer 200"
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  local started; started="$(date +%s)"
  while :; do
    code="$(http_code "$url")"
    if [ "$code" = "200" ]; then printf '\n'; note "healthy: HTTP 200 from $url"; return 0; fi
    # clouds with 1:1 nat never answer on their own public ip. after 30s, 127.0.0.1 is proof enough.
    if [ $(( $(date +%s) - started )) -ge 30 ] && [ "$(http_code "$local_url")" = "200" ]; then break; fi
    if [ "$(date +%s)" -ge "$deadline" ]; then break; fi
    printf '.'
    sleep 3
  done
  printf '\n'
  local_code="$(http_code "$local_url")"
  if [ "$local_code" = "200" ]; then
    warn "the stack answers on 127.0.0.1 but not on ${PUBLIC_IP} from this machine (last: HTTP ${code})."
    note "Normal on clouds that NAT the public ip (AWS/GCP). Try it from your browser; if that fails,"
    note "check the cloud firewall and that PUBLIC_IP is right (./deploy.sh <ip> to change it)."
    note "On a home lan this means PUBLIC_IP is the router's wan ip: the pages load, but video stays"
    note "black for every watcher on the lan. Use the lan ip instead: ./deploy.sh <lan ip>"
    return 0
  fi
  warn "no 200 from ${url} after ${HEALTH_TIMEOUT}s (last: HTTP ${code}; 000 = no connection)."
  note "look at:  ${DOCKER[*]} compose logs api frontend certs"
  return 1
}

show_result() {
  local ok="$1"
  say "containers"
  "${DOCKER[@]}" compose ps || true
  cat <<EOF

########################################################################
#
#   OPEN IN A BROWSER:   https://${PUBLIC_IP}/
#
########################################################################

  The cert is self-signed, so the browser warns. Click "Advanced" ->
  "Proceed to ${PUBLIC_IP} (unsafe)". Camera only works on https, so this
  warning is expected. The site works after you proceed.

  Watch logs:   ${DOCKER[*]} compose logs -f video api
  Health:       https://${PUBLIC_IP}/api/health     errors from the pages: https://${PUBLIC_IP}/admin  (ADMIN_NAMES in .env)
  Env name:     ${ENV_NAME:-unnamed}       (ENV_NAME in .env; in every health answer and stored error)   build: ${BUILD:-dev}
  Accounts:     optional, https://${PUBLIC_IP}/signup     forgot one: ./deploy.sh passwd <name>
  Stop:         ${DOCKER[*]} compose down        (add -v to also drop the database)
  Change ip:    ./deploy.sh 1.2.3.4
  Update:       ./deploy.sh --pull               (or: ./deploy.sh api)
EOF
  if [ "$ok" -ne 1 ]; then
    printf '\n  NOTE: the health check did not pass; the url above may not work yet. Check the logs first.\n'
  fi
}

# ---- main --------------------------------------------------------------------
full_deploy() {
  ensure_curl
  pick_public_ip "$IP_ARG"
  ensure_docker
  pick_docker_cmd
  ensure_compose
  check_ports
  [ "$PRUNE" = 0 ] || prune_for_deploy   # before the disk check, so a full box can pass it
  check_disk
  ensure_swap
  pick_build_jobs
  open_firewall
  write_env
  pick_env_name
  [ "$IMAGES_MODE" = 0 ] || setup_images_mode   # after write_env, which rewrites .env
  compose_up
  local ok=1
  wait_for_health || ok=0
  show_result "$ok"
  if [ "$ok" -eq 1 ]; then record_deployed; fi
  [ "$ok" -eq 1 ]
}

partial_deploy() {
  ensure_curl
  load_public_ip_from_env
  pick_docker_cmd
  ensure_compose
  [ "$PRUNE" = 0 ] || prune_for_deploy
  check_disk     # the same multi-GB builds as a full run, and swap is gone after a reboot
  ensure_swap
  pick_build_jobs
  refresh_env
  [ "$IMAGES_MODE" = 0 ] || setup_images_mode
  say "redeploying: ${TARGETS[*]}   (PUBLIC_IP=$PUBLIC_IP from $ENV_FILE, $([ "$IMAGES_MODE" = 1 ] && echo "images $IMAGES tag $TAG" || echo "BUILD=$BUILD"))"
  redeploy_targets
  local -a swapped=(); read -r -a swapped <<< "$(swapped_containers)" || true
  [ ${#swapped[@]} -eq 0 ] || check_swapped "${swapped[@]}"   # exits non-zero when one is not up
  prune_images
  local ok=1
  wait_for_health || ok=0
  say "containers"
  "${DOCKER[@]}" compose ps || true
  if [ "$ok" -eq 1 ]; then record_deployed; note "done. https://${PUBLIC_IP}/"; fi
  [ "$ok" -eq 1 ]
}

# the commit the images are built from, baked in as BUILD (see docs/debugging.md).
# -dirty when what the images are built from (api/ video/ frontend/ Cargo.toml
# Cargo.lock) has edits or new files; docs, tests and this script do not count.
# "dev" when this is not a git checkout.
pick_build() {
  if [ -n "${BUILD:-}" ]; then export BUILD; return 0; fi
  BUILD="$(git rev-parse --short HEAD 2>/dev/null || echo dev)"
  if [ "$BUILD" != dev ] && [ -n "$(git status --porcelain -- api video frontend Cargo.toml Cargo.lock 2>/dev/null)" ]; then
    BUILD="$BUILD-dirty"
  fi
  export BUILD
}

main() {
  cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [ -f docker-compose.yml ] || die "docker-compose.yml not found next to deploy.sh"
  ORIGINAL_ARGS=("$@")
  parse_args "$@"

  if [ -n "$PASSWD_NAME" ]; then
    passwd_account "$PASSWD_NAME"
    exit 0
  fi

  if [ "$PULL" = 1 ]; then
    pull_repo
    reexec_if_updated
    # with --images, "what changed in the repo" is not the question: the new TAG is. pull it all.
    if [ ${#TARGETS[@]} -eq 0 ] && [ "$IMAGES_MODE" = 0 ]; then
      if [ "$OLD_HEAD" = "$NEW_HEAD" ]; then
        say "nothing changed since the last deploy, nothing to redeploy"
        refresh_env
        # nothing to build, but the prune was asked for: still give the disk back
        [ "$PRUNE" = 0 ] || { pick_docker_cmd; prune_for_deploy; }
        exit 0
      fi
      local changed svc
      changed="$(changed_services "$OLD_HEAD" "$NEW_HEAD")"
      if [ -z "$changed" ]; then
        say "$(git rev-parse --short "$OLD_HEAD") -> $(git rev-parse --short "$NEW_HEAD") changed no service files (docs only?), nothing to redeploy"
        refresh_env
        # the new head runs the same containers the old one did, so it is as deployed
        if [ -f "$DEPLOYED_FILE" ] && [ "$(tr -d '[:space:]' < "$DEPLOYED_FILE")" = "$OLD_HEAD" ]; then record_deployed; fi
        [ "$PRUNE" = 0 ] || { pick_docker_cmd; prune_for_deploy; }
        exit 0
      fi
      # deploy order, not alphabetical: pages and images first, compose last, so its
      # `up -d` starts the new images instead of the old ones (and a second swap)
      for svc in frontend api video dummy caddy compose; do
        if grep -qx "$svc" <<< "$changed"; then TARGETS+=("$svc"); fi
      done
      note "changed: ${TARGETS[*]}"
    fi
  fi

  pick_build   # after the pull, so BUILD is the commit that is actually built
  if [ ${#TARGETS[@]} -gt 0 ]; then
    partial_deploy
  else
    full_deploy
  fi
}

# one line on purpose: bash parses it whole before running it, so a pull that
# rewrites this file mid-run can never feed the old process half a new line.
main "$@"; exit $?
