#!/usr/bin/env bash
set -euo pipefail

ENV_FILE=".env"
DEPLOYED_FILE=".deployed"
HEALTH_PATH="/api/health"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
TCP_PORTS="80 443"
UDP_PORTS="7882 7883"
MIN_RAM_MB=2048
BIG_RAM_MB=3500
SWAP_FILE="/swapfile"
SWAP_SIZE_MB=2048

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

DOCKER=(docker)

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

swap_mb() {
  [ "$OS" = linux ] || { echo 0; return 0; }
  awk '/^SwapTotal:/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0
}

env_file_value() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^[[:space:]]*$1=//p" "$ENV_FILE" | tail -n 1 | tr -d "\"' \t\r"
}

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

image_name() { printf '%sstream-%s:%s' "${IMAGES:-}" "$1" "${TAG:-latest}"; }
target_images() { local s; for s in pages api video dummy; do image_name "$s"; printf '\n'; done; }

lan_ip() {
  [ "$OS" = linux ] && have ip || return 0
  ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}' || true
}

detect_ip() {
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
  is_ipv4 "$PUBLIC_IP" || die "PUBLIC_IP '$PUBLIC_IP' ($IP_SOURCE) is not an IPv4 address. Try: ./scripts/deploy.sh 1.2.3.4"
  export PUBLIC_IP
  say "PUBLIC_IP = $PUBLIC_IP   ($IP_SOURCE)"
  note "override:  ./scripts/deploy.sh 1.2.3.4     or     PUBLIC_IP=1.2.3.4 ./scripts/deploy.sh"
  note "testing on your own lan? use this machine's lan ip, not 127.0.0.1 and not the router's public ip."
  if [ "$PUBLIC_IP" = "127.0.0.1" ]; then
    warn "127.0.0.1 only works for a browser on this exact machine, and video may not connect. prefer the lan ip."
  fi
  if [ "$IP_SOURCE" = "existing $ENV_FILE" ]; then
    detect_ip
    if [ "$DETECTED_IP" != "$PUBLIC_IP" ] && [ "$DETECTED_IP" != "127.0.0.1" ]; then
      warn "$ENV_FILE says $PUBLIC_IP but this machine looks like $DETECTED_IP ($DETECTED_VIA). ip changed? run: ./scripts/deploy.sh $DETECTED_IP"
    fi
  fi
  if [ "$OS" = linux ] && have ip && ! ip -4 -o addr 2>/dev/null | grep -q " $PUBLIC_IP/"; then
    local lan; lan="$(lan_ip)"
    if is_ipv4 "$lan" && [ "$lan" != "$PUBLIC_IP" ]; then
      warn "$PUBLIC_IP is not on any interface of this machine; its lan ip is $lan."
      note "cloud vm behind 1:1 nat (aws, gcp): $PUBLIC_IP is right, carry on."
      note "home or office lan: $PUBLIC_IP is the router. video stays black for everyone. switch with:  ./scripts/deploy.sh $lan"
    else
      note "$PUBLIC_IP is not on a local interface. fine on a cloud vm (1:1 nat). on a home lan use the lan ip."
    fi
  fi
}

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

ERROR: docker not found. Install Docker Desktop for Mac, start it, then re-run ./scripts/deploy.sh
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

pick_docker_cmd() {
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

prune_hint() {
  local a rest=()
  for a in ${ORIGINAL_ARGS[@]+"${ORIGINAL_ARGS[@]}"}; do
    [ "$a" = --prune-deploy ] || rest+=("$a")
  done
  printf './scripts/deploy.sh --prune-deploy%s' "${rest[@]+ ${rest[*]}}"
}

where_the_disk_went() {
  [ "$OS" = linux ] || return 0
  printf '  where the disk is:\n' >&2
  as_root du -xsh /usr /opt /var/log /var/cache/apt /var/lib/docker /var/lib/containerd /home /tmp "$SWAP_FILE" 2>/dev/null | sort -rh | head -n 6 | sed 's/^/    /' >&2 || true
}

check_disk() {
  local free_mb need=4000 total
  free_mb="$(free_mb_here)"
  if [ "${IMAGES_MODE:-0}" = 1 ]; then
    if [ "${free_mb:-0}" -lt 1500 ]; then
      if [ "${PRUNE:-0}" = 1 ]; then
        where_the_disk_went
        die "only ${free_mb}MB free here, even after the prune; pulling the images needs about 1.5 GB. what is left is not docker's to drop: grow the disk, or see what fills it. a logging agent that cannot reach its api writes a gigabyte of stack traces a day (journalctl -b -p warning | tail)"
      fi
      die "only ${free_mb}MB free here; pulling the images needs about 1.5 GB. try: $(prune_hint)   (drops what docker and the system's logs can spare)"
    fi
    return 0
  fi
  total="$(mem_mb)"
  if [ "$OS" = linux ] && [ ! -e "$SWAP_FILE" ] && [ "${total:-0}" -lt "$MIN_RAM_MB" ] && [ "$(swap_mb)" -eq 0 ]; then
    need=$(( need + SWAP_SIZE_MB ))
  fi
  if [ "${free_mb:-0}" -lt "$need" ]; then
    if [ "${PRUNE:-0}" = 1 ]; then
      where_the_disk_went
      die "only ${free_mb}MB free here (${need}MB is the floor), even after the prune. the rust images need about 6-8GB to build. grow the disk, or see what fills it: docker system df -v; journalctl -b -p warning | tail"
    fi
    die "only ${free_mb}MB free here (${need}MB is the floor). the rust images need about 6-8GB to build.
  try:  $(prune_hint)   (drops docker's build cache, unused images and the system's spare logs first, usually several GB)
  or grow the disk."
  fi
  if [ "${free_mb:-0}" -lt 10000 ]; then
    warn "${free_mb}MB free is tight. the rust builds use about 6-8GB while compiling."
  fi
}

prune_for_deploy() {
  local before after old n
  before="$(free_mb_here)"
  say "giving the disk back what it can spare (--prune-deploy). ${before}MB free now"
  note "build cache:      $("${DOCKER[@]}" builder prune -af 2>&1 | tail -n 1 || echo "could not prune it")"
  note "untagged images:  $("${DOCKER[@]}" image prune -f 2>&1 | tail -n 1 || echo "could not prune them")"
  old="$(comm -23 <("${DOCKER[@]}" images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -v '<none>' | sort -u) \
                 <({ "${DOCKER[@]}" ps -a --format '{{.Image}}' 2>/dev/null; target_images; } | sort -u) || true)"
  if [ -n "$old" ]; then
    # shellcheck disable=SC2086
    old="$("${DOCKER[@]}" rmi $old 2>/dev/null | sed -n 's/^Untagged: //p' | grep -v '@sha256:' || true)"
    if [ -n "$old" ]; then
      note "unused images:    $(echo "$old" | wc -l | tr -d ' ') removed ($(echo "$old" | tr '\n' ' '))"
    else
      note "unused images:    none"
    fi
  fi
  if [ "$OS" = linux ]; then
    ! have journalctl || note "journal:          $(as_root journalctl --vacuum-size=100M 2>&1 | tail -n 1 || echo "could not vacuum it")"
    n="$(as_root find /var/log -xdev -type f \( -name '*.[0-9]' -o -name '*.gz' -o -name '*-20[0-9][0-9]-*' \) \
          -not -path '/var/log/journal/*' -not -name 'wtmp*' -not -name 'btmp*' -not -name 'lastlog*' -print -delete 2>/dev/null | wc -l | tr -d ' ')"
    note "rotated logs:     ${n:-0} removed"
    n="$(as_root find /var/log -xdev -type f -size +50M \
          -not -path '/var/log/journal/*' -not -name 'wtmp*' -not -name 'btmp*' -not -name 'lastlog*' -print -exec truncate -s 0 {} + 2>/dev/null | wc -l | tr -d ' ')"
    note "live logs:        ${n:-0} over 50MB cut to nothing"
    if have apt-get; then
      if as_root apt-get clean >/dev/null 2>&1; then note "apt cache:        cleared"; else note "apt cache:        could not clear it"; fi
    fi
  fi
  after="$(free_mb_here)"
  note "${after}MB free, $(( after - before ))MB back. the next build of every project compiles from scratch"
}

ensure_swap() {
  [ "$OS" = linux ] || return 0
  [ "${IMAGES_MODE:-0}" = 0 ] || return 0
  local total swap
  total="$(mem_mb)"
  swap="$(swap_mb)"
  if [ "${total:-0}" -ge "$MIN_RAM_MB" ] || [ "${swap:-0}" -gt 0 ]; then return 0; fi
  say "${total:-?}MB RAM and no swap. adding a ${SWAP_SIZE_MB}MB swapfile so the rust build doesn't get killed"
  if ! can_root; then warn "no root/sudo; skipping swap. The build may run out of memory."; return 0; fi
  local made=0
  if [ ! -e "$SWAP_FILE" ]; then
    as_root touch "$SWAP_FILE"
    as_root chattr +C "$SWAP_FILE" 2>/dev/null || true
    as_root dd if=/dev/zero of="$SWAP_FILE" bs=1M count="$SWAP_SIZE_MB" status=none
    as_root chmod 600 "$SWAP_FILE"
    as_root mkswap "$SWAP_FILE" >/dev/null
    made=1
  fi
  if as_root swapon "$SWAP_FILE" 2>/dev/null; then
    note "swap is on for this session only (not in /etc/fstab; gone after reboot)."
    note "remove it now with:  sudo swapoff $SWAP_FILE && sudo rm $SWAP_FILE"
  else
    if [ "$made" = 1 ] || [ "$(as_root dd if="$SWAP_FILE" bs=1 skip=$(( $(getconf PAGESIZE 2>/dev/null || echo 4096) - 10 )) count=10 2>/dev/null)" != SWAPSPACE2 ]; then
      warn "swapon $SWAP_FILE failed (container/VPS without swap support?); removed it. Continuing without swap."
      as_root rm -f "$SWAP_FILE"
    else
      warn "swapon $SWAP_FILE failed, and it is a swapfile that was already here (swapped off by hand?): left alone. Continuing without swap."
    fi
  fi
}

open_firewall() {
  local p ufw_out=""
  if [ "$OS" = linux ] && have ufw && can_root; then
    ufw_out="$(as_root ufw status 2>/dev/null || true)"
  fi
  case "$ufw_out" in
  "Status: active"*)
    say "ufw is active, adding the ports the site needs"
    for p in $TCP_PORTS; do as_root ufw allow "$p/tcp" >/dev/null; note "ufw allow $p/tcp"; done
    for p in $UDP_PORTS; do as_root ufw allow "$p/udp" >/dev/null; note "ufw allow $p/udp"; done
    note "(docker-published ports bypass ufw anyway; this keeps 'ufw status' honest, it is not what opens them)"
    ;;
  esac
  say "firewall reminder"
  note "If this is a cloud machine, the provider firewall must ALSO allow inbound:"
  note "  tcp ${TCP_PORTS// /, }     (the site)"
  note "  udp ${UDP_PORTS// /, }   (the video itself, then voice. without it the page loads but video stays black)"
  note "AWS: security group.  GCP: VPC firewall rule.  Hetzner / DigitalOcean / Vultr: the cloud firewall on the server."
}

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
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
  say "wrote PUBLIC_IP=$PUBLIC_IP and CARGO_BUILD_JOBS=$CARGO_BUILD_JOBS to $ENV_FILE"
  sync_env_keys
}

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

refresh_env() {
  [ -f "$ENV_FILE" ] || return 0
  sync_env_keys
  pick_env_name
}

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
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
  export ENV_NAME
  say "wrote ENV_NAME=$ENV_NAME to $ENV_FILE ($via. prefer prod, dev, ...? edit that line)"
}

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

build_one() {
  if [ "${IMAGES_MODE:-0}" = 1 ]; then
    if "${DOCKER[@]}" image inspect "$(image_name "$1")" >/dev/null 2>&1; then
      note "$(image_name "$1") is here already"
      return 0
    fi
    ( [ -z "${PULL_PLATFORM:-}" ] || export DOCKER_DEFAULT_PLATFORM="$PULL_PLATFORM"; "${DOCKER[@]}" compose pull "$1" ) && return 0
    die "pulling $(image_name "$1") failed.
  'not found' / 'manifest unknown': nothing is pushed under tag $TAG yet. the github action builds it after a push to main
      (a few minutes: github.com/<you>/<repo>/actions), or ./scripts/ship.sh on the laptop pushes it. is the tag the commit you mean?
      (the tag is the last commit that touched api/ video/ frontend/ Cargo.* .dockerignore or the workflow, not HEAD)
      a release by number works too, the action tags every image with its v<n>:  ./scripts/deploy.sh --images v12
      images sent with ./scripts/ship.sh --to are named by the tag it printed:  ./scripts/deploy.sh --images <that tag>
  'denied' / 'unauthorized': the package is private. make it public (github.com → your profile → Packages → stream-$1 →
      Package settings → Change visibility), or log this machine in:  gh auth token | ${DOCKER[*]} login ghcr.io -u <you> --password-stdin   (token with read:packages)
  have here:  $("${DOCKER[@]}" images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E "^([^/]+/)*stream-$1:" | tr '\n' ' ' || true)
  or compile here instead:  ./scripts/deploy.sh --build ${ORIGINAL_ARGS[*]:-}"
  fi
  "${DOCKER[@]}" compose build --build-arg BUILD="${BUILD:-dev}" "$1" && return 0
  die "building $1 failed. 'signal: 9, SIGKILL' in the output means out of memory: add RAM or swap, or set CARGO_BUILD_JOBS=1."
}

UP_FLAGS=()

compose_up() {
  if [ "${IMAGES_MODE:-0}" = 1 ]; then
    say "getting the images (${IMAGES}stream-<x>:$TAG). nothing is built here"
  else
    say "building the images one at a time (first time: several minutes, CARGO_BUILD_JOBS=$CARGO_BUILD_JOBS, BUILD=$BUILD)"
  fi
  build_one pages
  build_one video
  build_one dummy
  build_one api
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
  up_voice
  sync_caddy
  prune_images
}

prune_images() {
  local out
  out="$("${DOCKER[@]}" image prune -f 2>/dev/null | tail -n 1 || true)"
  note "untagged images from earlier builds removed (${out:-nothing to remove}). the build cache stays; ./scripts/deploy.sh --prune-deploy drops it first next time"
}

container_state() {
  "${DOCKER[@]}" inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}} {{.State.ExitCode}}' "$1" 2>/dev/null \
    || echo "missing none 0 1"
}

wait_one_shot() {
  local status health restarts code n=0
  while :; do
    read -r status health restarts code <<< "$(container_state "$1")"
    case "$status" in running|created|restarting) ;; *) echo "$code"; return 0 ;; esac
    if [ "$n" -ge 60 ]; then echo running; return 0; fi
    sleep 2; n=$((n + 1))
  done
}

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
      elif [ "$status" != created ]; then
        swap_failed "$c" "$c is $status (health $health, $(( restarts - base )) restart(s) since the swap, exit code $code)"
      fi
      if [ "$(date +%s)" -ge "$deadline" ]; then swap_failed "$c" "$c is still $status / $health after 60s"; fi
      sleep 2
    done
  done
}

swap_failed() {
  printf '\n'
  "${DOCKER[@]}" compose logs --no-log-prefix --tail 30 "$1" 2>/dev/null || true
  die "redeploy failed: $2. above: the last 30 lines of its log. more: ${DOCKER[*]} compose logs $1"
}

redeploy_frontend() {
  build_one pages
  say "publishing the new pages (caddy keeps running)"
  "${DOCKER[@]}" compose up -d --no-deps ${UP_FLAGS[@]+"${UP_FLAGS[@]}"} pages
  local code; code="$(wait_one_shot pages)"
  "${DOCKER[@]}" compose logs --no-log-prefix --tail 1 pages 2>/dev/null || true
  [ "$code" = 0 ] || swap_failed pages "publishing the pages failed (pages exit code: $code)"
}

reload_caddy() {
  local out n status
  for n in 1 2 3; do
    if out="$("${DOCKER[@]}" compose exec -T frontend caddy reload --config - --adapter caddyfile < frontend/Caddyfile 2>&1)"; then
      return 0
    fi
    [ "$n" -eq 3 ] || sleep 1
  done
  read -r status _ <<< "$(container_state frontend)"
  if [ "$status" = running ] \
     && ! "${DOCKER[@]}" compose exec -T frontend caddy validate --config - --adapter caddyfile < frontend/Caddyfile >/dev/null 2>&1; then
    printf '%s\n' "$out" >&2
    die "caddy rejected frontend/Caddyfile (its words above) and keeps the config it has. fix the file, then deploy again"
  fi
  printf '%s\n' "$out" >&2
  warn "caddy did not take the Caddyfile over a reload; recreating it instead (open websockets drop, browsers reconnect)"
  "${DOCKER[@]}" compose up -d --no-deps --force-recreate frontend
}

caddy_stale() {
  local mounted
  mounted="$("${DOCKER[@]}" compose exec -T frontend cat /etc/caddy/Caddyfile 2>/dev/null)" || return 0
  [ "$mounted" != "$(cat frontend/Caddyfile)" ]
}

sync_caddy() {
  local status out
  read -r status _ <<< "$(container_state frontend)"
  if [ "$status" != running ]; then
    note "caddy is $status, so there is no running config to bring up to frontend/Caddyfile"
    return 0
  fi
  if ! caddy_stale; then
    reload_caddy
    return 0
  fi
  if ! out="$("${DOCKER[@]}" compose exec -T frontend caddy validate --config - --adapter caddyfile < frontend/Caddyfile 2>&1)"; then
    printf '%s\n' "$out" >&2
    die "caddy rejected frontend/Caddyfile (its words above) and keeps the config it has. fix the file, then deploy again"
  fi
  say "frontend/Caddyfile changed since caddy started, recreating it (open websockets drop, browsers reconnect)"
  "${DOCKER[@]}" compose up -d --no-deps --force-recreate frontend
}

redeploy_service() {
  if [ "$1" = video ]; then
    warn "redeploying video ends every live stream right now. watchers reconnect on their own; streamers press start again."
  fi
  build_one "$1"
  if [ "$1" = api ]; then
    "${DOCKER[@]}" compose up -d --no-deps --no-recreate s3
    say "swapping the api, chat, events and home containers"
    "${DOCKER[@]}" compose up -d --no-deps ${UP_FLAGS[@]+"${UP_FLAGS[@]}"} api chat events home
  else
    say "swapping the $1 container"
    "${DOCKER[@]}" compose up -d --no-deps ${UP_FLAGS[@]+"${UP_FLAGS[@]}"} "$1"
  fi
}

image_moved() {
  local running wanted
  running="$("${DOCKER[@]}" inspect -f '{{.Image}}' "$1" 2>/dev/null || true)"
  [ -n "$running" ] || return 1
  wanted="$("${DOCKER[@]}" image inspect -f '{{.Id}}' "$(image_name "$1")" 2>/dev/null || true)"
  [ -n "$wanted" ] && [ "$running" != "$wanted" ]
}

redeploy_dummy() {
  build_one dummy
  local -a also=() moved=()
  local svc
  for svc in video api; do
    if [ "${IMAGES_MODE:-0}" = 1 ] && image_moved "$svc"; then moved+=("$svc"); else also+=("$svc"); fi
  done
  say "swapping the dummy container$([ ${#also[@]} -eq 0 ] || echo " (${also[*]} too, recreated only if DUMMY_PASSWORD changed; video ends every live stream then)")"
  "${DOCKER[@]}" compose up -d --no-deps ${UP_FLAGS[@]+"${UP_FLAGS[@]}"} dummy ${also[@]+"${also[@]}"}
  if [ ${#moved[@]} -gt 0 ]; then
    warn "the images moved since ${moved[*]} started, so they were left alone.
  a changed DUMMY_PASSWORD reaches them with:  ./scripts/deploy.sh ${moved[*]}   (video ends every live stream)"
  fi
  note "dummy streams: $(env_file_value DUMMY_STREAMS)   (DUMMY_STREAMS in $ENV_FILE)"
}

voice_on() { [ -n "$(env_file_value VOICE_SECRET)" ]; }

up_voice() {
  if ! voice_on; then note "voice is off (no VOICE_SECRET in $ENV_FILE), leaving it alone"; return 0; fi
  say "bringing voice up to the video image (a swap drops every voice call; pages rejoin)"
  "${DOCKER[@]}" compose --profile voice up -d --no-deps ${UP_FLAGS[@]+"${UP_FLAGS[@]}"} voice
}

redeploy_targets() {
  local t voice=0
  for t in ${TARGETS[@]+"${TARGETS[@]}"}; do
    case "$t" in
      frontend) redeploy_frontend; sync_caddy ;;
      api|video) redeploy_service "$t" ;;
      dummy) redeploy_dummy ;;
      voice) ! voice_on || build_one video ;;
      caddy) say "Caddyfile changed, bringing caddy up to it"; sync_caddy ;;
      compose) say "docker-compose.yml changed, applying it"; "${DOCKER[@]}" compose up -d ${UP_FLAGS[@]+"${UP_FLAGS[@]}"} ;;
    esac
    case "$t" in video|voice|compose) voice=1 ;; esac
  done
  [ "$voice" = 0 ] || up_voice
}

swapped_containers() {
  local t out=""
  for t in ${TARGETS[@]+"${TARGETS[@]}"}; do
    case "$t" in
      frontend) out="$out frontend" ;;
      api) out="$out api chat events home" ;;
      video) out="$out video" ;;
      dummy) out="$out dummy video api" ;;
      caddy) out="$out frontend" ;;
      compose) out="$out frontend api chat events home database redis video dummy s3" ;;
    esac
    case "$t" in video|voice|compose) ! voice_on || out="$out voice" ;; esac
  done
  printf '%s\n' $out | awk 'NF && !seen[$0]++' | tr '\n' ' '
}

pull_repo() {
  have git || die "git not found"
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "this folder is not a git checkout, nothing to pull"
  git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1 \
    || die "this branch has no upstream to pull from. on your machine: git push -u origin <branch>"
  local head; head="$(git rev-parse HEAD)"
  OLD_HEAD="${DEPLOY_PULLED_FROM:-$(last_deployed "$head")}"
  say "git pull --ff-only"
  git pull --ff-only || die "pull failed. local edits in the way? see: git status"
  GIT_TERMINAL_PROMPT=0 git fetch --tags --quiet origin 2>/dev/null || note "could not fetch the tags; the release may read older than it is"
  TAGS_FETCHED=1
  NEW_HEAD="$(git rev-parse HEAD)"
  if [ "$head" = "$NEW_HEAD" ]; then note "already up to date"; else note "$(git log --oneline "$head..$NEW_HEAD" | wc -l | tr -d ' ') new commit(s)"; fi
  if [ "$OLD_HEAD" != "$head" ]; then
    note "the last run that ended well deployed $(git rev-parse --short "$OLD_HEAD"), not $(git rev-parse --short "$head"): what changed since then counts too"
  fi
}

last_deployed() {
  local d=""
  [ ! -f "$DEPLOYED_FILE" ] || d="$(tr -d '[:space:]' < "$DEPLOYED_FILE")"
  if [ -n "$d" ] && git merge-base --is-ancestor "$d" HEAD 2>/dev/null; then echo "$d"
  else
    [ -z "$d" ] || note "$DEPLOYED_FILE says $d, which is not on this branch; going by HEAD instead" >&2
    echo "$1"
  fi
}

record_deployed() {
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
  git rev-parse HEAD > "$DEPLOYED_FILE" 2>/dev/null || true
}

pick_release() {
  RELEASE=""
  if [[ "${TAG:-}" =~ ^v[0-9]+$ ]]; then RELEASE="$TAG"; export RELEASE; return 0; fi
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
  if [ "${TAGS_FETCHED:-0}" = 0 ] && git remote get-url origin >/dev/null 2>&1; then
    GIT_TERMINAL_PROMPT=0 git fetch --tags --quiet origin 2>/dev/null || true
  fi
  local n; n="$(git tag --merged HEAD --list 'v[0-9]*' 2>/dev/null | grep -E '^v[0-9]+$' | sed 's/^v//' | sort -n | tail -n 1 || true)"
  [ -n "$n" ] || return 0
  RELEASE="v$n"
  local ic; ic="$(image_commit)"
  if [ -n "$ic" ] && ! git merge-base --is-ancestor "$ic" "v$n" 2>/dev/null; then RELEASE="v$n+$ic"; fi
  export RELEASE
}

record_release() {
  if [ -z "${RELEASE:-}" ]; then
    note "no release to record: no v<n> tag reaches HEAD (the action makes one per push to main it builds). /api/health says \"version\": null"
    return 0
  fi
  local commit out
  commit="$(git rev-parse HEAD 2>/dev/null || true)"
  if out="$("${DOCKER[@]}" compose exec -T -e RUST_LOG=warn api api release "$RELEASE" "$commit" 2>&1)"; then
    note "release $RELEASE recorded: what /api/health says under \"version\""
  else
    warn "could not record release $RELEASE (${out:-no output}). /api/health keeps the one before. an api image older than the deploys table?"
  fi
}

reexec_if_updated() {
  [ -z "${DEPLOY_REEXEC:-}" ] || return 0
  [ -n "$(git diff --name-only "$OLD_HEAD" "$NEW_HEAD" -- scripts/deploy.sh)" ] || return 0
  say "deploy.sh itself changed in the pull, continuing with the new one"
  DEPLOY_REEXEC=1 DEPLOY_PULLED_FROM="$OLD_HEAD" exec bash ./scripts/deploy.sh ${ORIGINAL_ARGS[@]+"${ORIGINAL_ARGS[@]}"}
}

changed_services() {
  git diff --name-only "$1" "$2" | while IFS= read -r f; do
    case "$f" in
      Cargo.toml|Cargo.lock) printf 'api\nvideo\ndummy\n' ;;
      .dockerignore) printf 'api\nvideo\ndummy\n' ;;
      frontend/.dockerignore) echo frontend ;;
      api/*) echo api ;;
      video/*) printf 'video\ndummy\n' ;;
      random-media/gifs/*) echo dummy ;;
      random-media/vrms/*) echo models ;;
      frontend/Caddyfile) echo caddy ;;
      frontend/*) echo frontend ;;
      docker-compose.yml) echo compose ;;
    esac
  done | sort -u
}

sync_models() {
  [ -f scripts/models.sh ] && [ -d random-media/vrms ] || return 0
  DOCKER_CMD="${DOCKER[*]-}" bash ./scripts/models.sh --if-changed || warn "the demo models did not go up (above). the stack is fine; ./scripts/models.sh tries again"
}

passwd_account() {
  pick_docker_cmd
  [ -n "$("${DOCKER[@]}" compose ps -q api 2>/dev/null)" ] || die "the api container is not up. ./scripts/deploy.sh first"
  "${DOCKER[@]}" compose exec -T -e RUST_LOG=warn api api passwd "$1"
}

usage() {
  local B="" N=""
  if [ -t 1 ]; then
    B="$(tput bold 2>/dev/null || printf '\033[1m')"
    N="$(tput sgr0 2>/dev/null || printf '\033[0m')"
  fi
  cat <<EOF
${B}usage:${N} ./scripts/deploy.sh [--pull] [--prune-deploy] [--build | --images [TAG]] [PUBLIC_IP] [frontend|api|video|dummy|voice ...]
       ./scripts/deploy.sh passwd <name>

${B}what to deploy${N}
  ${B}(nothing named)${N}           full deploy: machine setup, every image, docker compose up
  ${B}frontend api video dummy voice${N}
                            just these: get (or build) their image, swap their containers (chat, events and
                            home move with api), then check them: running and healthy, or exit non-zero
  ${B}PUBLIC_IP${N}                 use this ip (full deploy only). otherwise: \$PUBLIC_IP > .env > auto-detect

${B}where the images come from${N}
  by default nothing is compiled here. the four images come from the registry the git remote implies
  (github.com/<you>/… → ghcr.io/<you>/; IMAGES= in .env or the environment to say otherwise), tagged
  with the last commit that touched what they are built from (./image-paths: api/ video/ frontend/
  Cargo.* …; docs and this script do not count): what the github action pushes, and what ./scripts/ship.sh
  tags with. an image already here under that name (./scripts/ship.sh --to sent it) is used as is. no 4 GB
  floor, no swapfile: a 1 GB box runs it.
  ${B}--images [TAG]${N}            the default, with a tag of your choosing: a release (v12; the action tags every
                            image with its v<n>), or the one ./scripts/ship.sh --to printed
  ${B}--build${N}                   compile the images here instead: an hour on a small machine, 4 GB of ram,
                            8 GB of disk. for a laptop with uncommitted changes, or a box with no registry

${B}flags${N}
  ${B}--pull${N}                    git pull --ff-only first. with no services named, redeploy what changed
                            since the last run that ended well (.deployed), so a --pull that
                            failed halfway is retried whole by the next one
  ${B}--prune-deploy${N}            first give the disk back what it can spare, then deploy as asked:
                            docker's build cache (every project's on this machine; each comes
                            back on its next build), untagged images, images no container has,
                            the journal's archives, rotated logs, live logs past 50MB (cut to
                            nothing) and apt's cache. for the box that says "only 2664MB free".
                            volumes, containers and the swapfile stay; so do the lines since boot

${B}other${N}
  ${B}passwd <name>${N}             print a new random password for that account. the only reset there is
  ${B}-h, --help${N}                this

${B}notes${N}
  dummy = the fake streams. set DUMMY_STREAMS and DUMMY_PASSWORD in .env first.
  voice = the voice channels: the video image under the compose profile voice, media on udp 7883. on only
  with VOICE_SECRET in .env (docs/voice.md); without it voice is skipped. whenever video is redeployed (a
  full deploy, video, a changed docker-compose.yml) voice is brought to the same image, which drops every voice call.
  new knobs from .env.example are appended to .env with their defaults on every run
  (also a --pull that finds nothing to redeploy). passwd touches nothing.
  a full deploy restarts video when the images moved since the last one (a commit that
  touched api/ video/ frontend/ Cargo.*; docs and this script do not count): every live stream ends.
  every run that ends well records its release (the highest v<n> tag reaching HEAD, the action's
  number for that push) in the database; /api/health says it under "version".
  after the health check, the demo models (random-media/vrms) go into the bucket when that folder changed since
  they last did (./scripts/models.sh --help). that never fails a run.
EOF
}

parse_args() {
  IP_ARG=""; PULL=0; PRUNE=0; IMAGES_MODE=0; BUILD_MODE=0; TAG="${TAG:-}"; TARGETS=(); PASSWD_NAME=""
  local a want_name=0 want_tag=0
  for a in "$@"; do
    if [ "$want_name" = 1 ]; then PASSWD_NAME="$a"; want_name=0; continue; fi
    if [ "$want_tag" = 1 ]; then
      want_tag=0
      case "$a" in
        -*|frontend|api|video|dummy|voice|pages|chat|events|home|passwd) ;;
        *) if ! is_ipv4 "$a" && [[ "$a" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then TAG="$a"; continue; fi ;;
      esac
    fi
    case "$a" in
      -h|--help) usage; exit 0 ;;
      --pull) PULL=1 ;;
      --prune-deploy) PRUNE=1 ;;
      --images) IMAGES_MODE=1; want_tag=1 ;;
      --images=*) IMAGES_MODE=1; TAG="${a#--images=}" ;;
      --build) BUILD_MODE=1 ;;
      passwd) want_name=1 ;;
      frontend|api|video|dummy|voice) TARGETS+=("$a") ;;
      pages) TARGETS+=("frontend") ;;
      chat|events|home) TARGETS+=("api") ;;
      *)
        if is_ipv4 "$a"; then IP_ARG="$a"
        else die "don't know what '$a' is. services are: frontend api video dummy voice. see ./scripts/deploy.sh --help"
        fi ;;
    esac
  done
  if [ "$want_name" = 1 ]; then die "usage: ./scripts/deploy.sh passwd <name>"; fi
  if [ -n "$PASSWD_NAME" ] && { [ "$PULL" = 1 ] || [ "$PRUNE" = 1 ] || [ "$IMAGES_MODE" = 1 ] || [ "$BUILD_MODE" = 1 ] || [ -n "$IP_ARG" ] || [ ${#TARGETS[@]} -gt 0 ]; }; then
    die "passwd goes alone: ./scripts/deploy.sh passwd $PASSWD_NAME"
  fi
  if [ "$IMAGES_MODE" = 1 ] && [ "$BUILD_MODE" = 1 ]; then die "--images and --build: pick one"; fi
  if [ -n "$IP_ARG" ] && [ ${#TARGETS[@]} -gt 0 ]; then
    die "changing the ip touches the cert, caddy and video. run a full deploy: ./scripts/deploy.sh $IP_ARG"
  fi
}

load_public_ip_from_env() {
  PUBLIC_IP="${PUBLIC_IP:-$(env_file_value PUBLIC_IP)}"
  is_ipv4 "${PUBLIC_IP:-}" || die "no PUBLIC_IP in $ENV_FILE. run a full deploy first: ./scripts/deploy.sh"
  export PUBLIC_IP
}

decide_mode() {
  [ "$BUILD_MODE" = 1 ] || IMAGES_MODE=1
}

registry_from_remote() {
  local url owner
  url="$(git remote get-url origin 2>/dev/null || true)"
  owner="$(printf '%s' "$url" | sed -E 's#^(https://github\.com/|git@github\.com:)([^/]+)/.*$#\2#' | tr '[:upper:]' '[:lower:]')"
  [ -n "$owner" ] && [ "$owner" != "$(printf '%s' "$url" | tr '[:upper:]' '[:lower:]')" ] || return 1
  printf 'ghcr.io/%s/' "$owner"
}

IMAGE_PATHSPECS=()
load_image_paths() {
  [ ${#IMAGE_PATHSPECS[@]} -eq 0 ] || return 0
  local p
  while IFS= read -r p; do IMAGE_PATHSPECS+=("$p"); done < <(tr -d '\r' < image-paths 2>/dev/null | sed -E 's/[[:space:]]+$//' | grep -Ev '^[[:space:]]*(#|$)' || true)
}

image_commit() {
  load_image_paths
  [ ${#IMAGE_PATHSPECS[@]} -gt 0 ] || return 0
  git log -1 --format=%h --abbrev=7 -- "${IMAGE_PATHSPECS[@]}" 2>/dev/null || true
}

images_dirty() {
  load_image_paths
  [ ${#IMAGE_PATHSPECS[@]} -gt 0 ] && [ -n "$(git status --porcelain -- "${IMAGE_PATHSPECS[@]}" 2>/dev/null)" ]
}

is_shallow() { [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = true ]; }

resolve_images() {
  [ -z "${IMAGES_RESOLVED:-}" ] || return 0
  IMAGES="${IMAGES:-$(env_file_value IMAGES)}"
  if [ -z "$IMAGES" ]; then
    IMAGES="$(registry_from_remote || true)"
    [ -n "$IMAGES" ] || die "cannot tell where the images live: the git remote is not on github. put IMAGES=<registry>/<owner>/ in $ENV_FILE, or build here:  ./scripts/deploy.sh --build ${ORIGINAL_ARGS[*]:-}"
  fi
  IMAGES="${IMAGES%/}/"
  if [ -z "$TAG" ]; then
    ! is_shallow || die "this is a shallow checkout, so the commit the images are named after cannot be found. once:  git fetch --unshallow"
    TAG="$(image_commit)"
    [ -n "$TAG" ] || die "cannot tell which images: not a git checkout. name them:  ./scripts/deploy.sh --images <tag>"
    ! images_dirty || warn "api/ video/ frontend/ or Cargo.* have uncommitted edits: the images for $TAG are the commit's, not this tree's. ./scripts/deploy.sh --build compiles this tree"
  fi
  PULL_PLATFORM=""
  case "$(uname -m)" in
    x86_64|amd64) ;;
    *) PULL_PLATFORM=linux/amd64
       note "this machine is $(uname -m); the images are linux/amd64 and will run under emulation. ./scripts/deploy.sh --build makes native ones" ;;
  esac
  export IMAGES TAG
  UP_FLAGS=(--no-build)
  IMAGES_RESOLVED=1
}

setup_images_mode() {
  resolve_images
  set_env_key IMAGES "$IMAGES"
  set_env_key TAG "$TAG"
  say "images: ${IMAGES}stream-<x>:$TAG   (nothing is built here; ./scripts/deploy.sh --build would. written to $ENV_FILE for a compose by hand)"
}

setup_build_mode() {
  export IMAGES="" TAG=""
}

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
    note "check the cloud firewall and that PUBLIC_IP is right (./scripts/deploy.sh <ip> to change it)."
    note "On a home lan this means PUBLIC_IP is the router's wan ip: the pages load, but video stays"
    note "black for every watcher on the lan. Use the lan ip instead: ./scripts/deploy.sh <lan ip>"
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
  Env name:     ${ENV_NAME:-unnamed}       (ENV_NAME in .env; in every health answer and stored error)   release: ${RELEASE:-none}   build: ${BUILD:-dev}
  Accounts:     optional, https://${PUBLIC_IP}/signup     forgot one: ./scripts/deploy.sh passwd <name>
  Stop:         ${DOCKER[*]} compose down        (add -v to also drop the database)
  Change ip:    ./scripts/deploy.sh 1.2.3.4
  Update:       ./scripts/deploy.sh --pull               (or: ./scripts/deploy.sh api)
EOF
  if [ "$ok" -ne 1 ]; then
    printf '\n  NOTE: the health check did not pass; the url above may not work yet. Check the logs first.\n'
  fi
}

full_deploy() {
  ensure_curl
  pick_public_ip "$IP_ARG"
  ensure_docker
  pick_docker_cmd
  ensure_compose
  check_ports
  [ "$IMAGES_MODE" = 0 ] || resolve_images
  [ "$PRUNE" = 0 ] || prune_for_deploy
  check_disk
  ensure_swap
  pick_build_jobs
  open_firewall
  write_env
  pick_env_name
  if [ "$IMAGES_MODE" = 1 ]; then setup_images_mode; else setup_build_mode; fi
  compose_up
  local ok=1
  wait_for_health || ok=0
  if [ "$ok" -eq 1 ]; then sync_models; fi
  show_result "$ok"
  if [ "$ok" -eq 1 ]; then record_deployed; record_release; fi
  [ "$ok" -eq 1 ]
}

partial_deploy() {
  ensure_curl
  load_public_ip_from_env
  pick_docker_cmd
  ensure_compose
  [ "$IMAGES_MODE" = 0 ] || resolve_images
  [ "$PRUNE" = 0 ] || prune_for_deploy
  check_disk
  ensure_swap
  pick_build_jobs
  refresh_env
  if [ "$IMAGES_MODE" = 1 ]; then setup_images_mode; else setup_build_mode; fi
  say "redeploying: ${TARGETS[*]}   (PUBLIC_IP=$PUBLIC_IP from $ENV_FILE, $([ "$IMAGES_MODE" = 1 ] && echo "images $IMAGES tag $TAG" || echo "building, BUILD=$BUILD"))"
  redeploy_targets
  local -a swapped=(); read -r -a swapped <<< "$(swapped_containers)" || true
  [ ${#swapped[@]} -eq 0 ] || check_swapped "${swapped[@]}"
  prune_images
  local ok=1
  wait_for_health || ok=0
  if [ "$ok" -eq 1 ]; then sync_models; fi
  say "containers"
  "${DOCKER[@]}" compose ps || true
  if [ "$ok" -eq 1 ]; then record_deployed; record_release; note "done. https://${PUBLIC_IP}/   (release ${RELEASE:-none}, build $BUILD)"; fi
  [ "$ok" -eq 1 ]
}

pick_build() {
  if [ -n "${BUILD:-}" ]; then export BUILD; return 0; fi
  BUILD="$(image_commit)"
  BUILD="${BUILD:-dev}"
  if [ "$BUILD" != dev ] && images_dirty; then
    BUILD="$BUILD-dirty"
  fi
  export BUILD
}

main() {
  cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  [ -f docker-compose.yml ] || die "docker-compose.yml not found in the repo root"
  ORIGINAL_ARGS=("$@")
  parse_args "$@"
  decide_mode

  if [ -n "$PASSWD_NAME" ]; then
    passwd_account "$PASSWD_NAME"
    exit 0
  fi

  if [ "$PULL" = 1 ]; then
    pull_repo
    reexec_if_updated
    if [ ${#TARGETS[@]} -eq 0 ] && [ "$IMAGES_MODE" = 0 ]; then
      if [ "$OLD_HEAD" = "$NEW_HEAD" ]; then
        say "nothing changed since the last deploy, nothing to redeploy"
        refresh_env
        sync_models
        [ "$PRUNE" = 0 ] || { pick_docker_cmd; prune_for_deploy; }
        exit 0
      fi
      local changed svc
      changed="$(changed_services "$OLD_HEAD" "$NEW_HEAD")"
      for svc in frontend api video dummy caddy compose; do
        if grep -qx "$svc" <<< "$changed"; then TARGETS+=("$svc"); fi
      done
      if [ ${#TARGETS[@]} -eq 0 ]; then
        local what="docs only?"
        ! grep -qx models <<< "$changed" || what="demo models"
        say "$(git rev-parse --short "$OLD_HEAD") -> $(git rev-parse --short "$NEW_HEAD") changed no service files ($what), nothing to redeploy"
        refresh_env
        sync_models
        if [ -f "$DEPLOYED_FILE" ] && [ "$(tr -d '[:space:]' < "$DEPLOYED_FILE")" = "$OLD_HEAD" ]; then record_deployed; fi
        [ "$PRUNE" = 0 ] || { pick_docker_cmd; prune_for_deploy; }
        exit 0
      fi
      note "changed: ${TARGETS[*]}"
    fi
  fi

  pick_build
  pick_release
  if [ ${#TARGETS[@]} -gt 0 ]; then
    partial_deploy
  else
    full_deploy
  fi
}

main "$@"; exit $?
