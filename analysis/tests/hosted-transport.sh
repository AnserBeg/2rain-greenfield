#!/usr/bin/env bash
# Integration proof on the ephemeral Actions VM only. Pin the test server host
# key and restrict the test identity to the worker's framed stdin/stdout.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true ]]
umask 077
transport=$(mktemp -d "$HOME/analysis-ssh-XXXXXX")
ssh-keygen -q -t ed25519 -N '' -f "$transport/server"
ssh-keygen -q -t ed25519 -N '' -f "$transport/client"
printf 'restrict,command="%s/analysis/analysis-worker" %s\n' "$GITHUB_WORKSPACE" "$(cat "$transport/client.pub")" >"$transport/authorized_keys"
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
sudo install -d -m 0755 -o root -g root /run/sshd
sudo /usr/sbin/sshd -f /dev/null -E "$transport/server.log" -p 22022 \
  -o ListenAddress=127.0.0.1 -o PidFile="$transport/pid" -o HostKey="$transport/server" \
  -o AuthorizedKeysFile="$transport/authorized_keys" -o AllowUsers="$(id -un)" \
  -o UsePAM=yes -o AuthenticationMethods=publickey -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o PermitTTY=no \
  -o DisableForwarding=yes || {
  sudo cat "$transport/server.log"
  exit 1
}
cleanup() {
  if [[ $? != 0 ]]; then sudo cat "$transport/server.log"; fi
  sudo kill "$(cat "$transport/pid")"
  rm -rf "$transport"
}
trap cleanup EXIT
export ANALYSIS_RUNNER_HOST=analysis-fixture ANALYSIS_SSH_CONFIG="$transport/config"
node analysis/controller.mjs probe >/dev/null
cp "$transport/known_hosts" "$transport/pinned"
echo "[127.0.0.1]:22022 $(cat "$transport/client.pub")" >"$transport/known_hosts"
if node analysis/controller.mjs probe >"$transport/reply" 2>"$transport/error"; then
  echo "controller accepted the wrong SSH host key" >&2
  exit 1
fi
grep -Fx 'worker transport interrupted' "$transport/error"
test ! -s "$transport/reply"
mv "$transport/pinned" "$transport/known_hosts"
analysis/tests/fixture-db.sh --science
