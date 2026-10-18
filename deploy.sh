#!/usr/bin/env bash
#
# deploy.sh — bring the stream lab up on this machine.
#
#   ./deploy.sh                 auto-detect PUBLIC_IP
#   ./deploy.sh 203.0.113.7     use this ip
#   PUBLIC_IP=10.0.0.5 ./deploy.sh
#
# Linux (Ubuntu 22.04/24.04, Debian 12): installs docker if missing, refuses if
# 80/443 are taken, adds a 2G swapfile on small boxes, opens ufw ports, writes
# .env, builds the frontend and the two rust images one at a time, starts
# everything, waits for /api/health. Exits non-zero if the health check fails.
# macOS (Docker Desktop): same, minus install / swap / ufw; PUBLIC_IP comes from
# en0/en1 (no ipify lookup).
#
# Stop everything later with:  docker compose down
#
set -euo pipefail

# ---- knobs -------------------------------------------------------------------
ENV_FILE=".env"
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

# ---- 1. PUBLIC_IP ------------------------------------------------------------
env_file_value() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^[[:space:]]*$1=//p" "$ENV_FILE" | tail -n 1 | tr -d "\"' \t\r"
}

detect_ip() {   # sets DETECTED_IP / DETECTED_VIA
  DETECTED_IP=""; DETECTED_VIA=""
  local c="" iface
  if [ "$OS" = linux ]; then
    c="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || true)"
    if is_ipv4 "$c"; then DETECTED_IP="$c"; DETECTED_VIA="public ip via api.ipify.org"; fi
    if [ -z "$DETECTED_IP" ] && have ip; then
      c="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}' || true)"
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
  # a public ip that is not on any interface is right behind cloud 1:1 nat, wrong on a home lan
  if [ "$OS" = linux ] && have ip && ! ip -4 -o addr 2>/dev/null | grep -q " $PUBLIC_IP/"; then
    note "$PUBLIC_IP is not on a local interface. fine on a cloud vm (1:1 nat). on a home lan use the lan ip."
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

check_disk() {
  local free_mb
  free_mb="$(df -Pm . 2>/dev/null | awk 'NR==2 {print $4}' || echo 0)"
  if [ "${free_mb:-0}" -lt 4000 ]; then
    die "only ${free_mb}MB free here. the rust images need about 6-8GB to build. grow the disk first."
  fi
  if [ "${free_mb:-0}" -lt 10000 ]; then
    warn "${free_mb}MB free is tight. the rust builds use about 6-8GB while compiling."
  fi
}

# ---- 4. swap -----------------------------------------------------------------
ensure_swap() {
  [ "$OS" = linux ] || return 0
  local total swap_mb
  total="$(mem_mb)"
  swap_mb="$(awk '/^SwapTotal:/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
  if [ "${total:-0}" -ge "$MIN_RAM_MB" ] || [ "${swap_mb:-0}" -gt 0 ]; then return 0; fi
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
    say "ufw is active, opening the ports the site needs"
    for p in $TCP_PORTS; do as_root ufw allow "$p/tcp" >/dev/null; note "ufw allow $p/tcp"; done
    for p in $UDP_PORTS; do as_root ufw allow "$p/udp" >/dev/null; note "ufw allow $p/udp"; done
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
build_one() {
  "${DOCKER[@]}" compose build "$1" && return 0
  die "building $1 failed. 'signal: 9, SIGKILL' in the output means out of memory: add RAM or swap, or set CARGO_BUILD_JOBS=1."
}

compose_up() {
  say "building the images one at a time (first time: several minutes, CARGO_BUILD_JOBS=$CARGO_BUILD_JOBS)"
  build_one frontend
  build_one video
  build_one api
  say "${DOCKER[*]} compose up -d"
  "${DOCKER[@]}" compose up -d
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
  Stop:         ${DOCKER[*]} compose down        (add -v to also drop the database)
  Change ip:    ./deploy.sh 1.2.3.4
EOF
  if [ "$ok" -ne 1 ]; then
    printf '\n  NOTE: the health check did not pass; the url above may not work yet. Check the logs first.\n'
  fi
}

# ---- main --------------------------------------------------------------------
main() {
  case "${1:-}" in
    -h|--help)
      printf 'usage: ./deploy.sh [PUBLIC_IP]\n  PUBLIC_IP: arg > $PUBLIC_IP env > existing .env (non-127.0.0.1) > auto-detect\n'
      exit 0 ;;
  esac
  cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [ -f docker-compose.yml ] || die "docker-compose.yml not found next to deploy.sh"

  ensure_curl
  pick_public_ip "${1:-}"
  ensure_docker
  pick_docker_cmd
  ensure_compose
  check_ports
  check_disk
  ensure_swap
  pick_build_jobs
  open_firewall
  write_env
  compose_up
  local ok=1
  wait_for_health || ok=0
  show_result "$ok"
  [ "$ok" -eq 1 ]
}

main "$@"
