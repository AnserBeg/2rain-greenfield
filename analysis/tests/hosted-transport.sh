#!/usr/bin/env bash
# Integration proof on the ephemeral Actions VM only. Pin the test server host
# key and restrict the test identity to the worker's framed stdin/stdout.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true ]]
umask 077
transport=$(mktemp -d "$RUNNER_TEMP/analysis-ssh-XXXXXX")
ssh-keygen -q -t ed25519 -N '' -f "$transport/server"
ssh-keygen -q -t ed25519 -N '' -f "$transport/client"
echo "[127.0.0.1]:22022 $(cat "$transport/server.pub")" >"$transport/known_hosts"
cat > "$transport/config" <<EOF
Host analysis-fixture
  HostName 127.0.0.1
  Port 22022
  User $(id -un)
  IdentityFile $transport/client
  IdentitiesOnly yes
  UserKnownHostsFile $transport/known_hosts
EOF
sudo /usr/sbin/sshd -f /dev/null -E "$transport/server.log" -p 22022 \
  -o ListenAddress=127.0.0.1 -o PidFile="$transport/pid" -o HostKey="$transport/server" \
  -o AuthorizedKeysFile="$transport/client.pub" -o AllowUsers="$(id -un)" \
  -o AuthenticationMethods=publickey -o PasswordAuthentication=no -o PermitTTY=no \
  -o DisableForwarding=yes -o ForceCommand="$GITHUB_WORKSPACE/analysis/analysis-worker"
cleanup() {
  sudo kill "$(cat "$transport/pid")"
  rm -rf "$transport"
}
trap cleanup EXIT
export ANALYSIS_RUNNER_HOST=analysis-fixture ANALYSIS_SSH_CONFIG="$transport/config"
analysis/tests/fixture-db.sh --science
