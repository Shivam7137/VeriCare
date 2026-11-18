#!/usr/bin/env bash
# Boots the hosted demo: a private Postgres on loopback, fresh fictional data, long-lived demo
# sessions, then the API, worker and web app. Only the web app listens beyond loopback.
set -euo pipefail
cd "$(dirname "$0")/../.."

# Hugging Face sets SPACE_HOST; PUBLIC_DEMO_ORIGIN can override it elsewhere.
if [[ -z "${PUBLIC_DEMO_ORIGIN:-}" && -n "${SPACE_HOST:-}" ]]; then
  export PUBLIC_DEMO_ORIGIN="https://${SPACE_HOST}"
fi

# Non-secret configuration. Values already in the environment (Space variables and secrets)
# win over this file. Texts, calls and the language model stay off unless configured.
cat > .env <<EOF
DATABASE_URL=postgresql://prc@127.0.0.1:5432/prc
API_HOST=127.0.0.1
API_PORT=4100
API_URL=http://127.0.0.1:4100
ENABLE_SYNTHETIC_DEMO=true
PUBLIC_DEMO_ORIGIN=${PUBLIC_DEMO_ORIGIN:-}
SMS_APP_URL=${PUBLIC_DEMO_ORIGIN:-}
AGENT_AUTO_PROPOSE=false
VOICE_MODE=simulated
VOICE_LIVE_ENABLED=false
VOICE_SCENARIO=emergency_contact
VOICE_DEPARTMENT_ID=demo-department
DEMO_EMERGENCY_CONTACT_NAME="Jordan Chen"
DEMO_EMERGENCY_CONTACT_RELATIONSHIP=Brother
DEMO_EMERGENCY_CONTACT_PHONE=+19025550147
VISIT_AGENT_ENABLED=${VISIT_AGENT_ENABLED:-false}
KB_EMBEDDINGS=false
JOURNEY_SMS_ENABLED=false
DEMO_SESSION_HOURS=${DEMO_SESSION_HOURS:-720}
EOF
set -a
# shellcheck disable=SC1091
source .env
set +a

pgdata="$HOME/pgdata"
rm -rf "$pgdata" .env.sessions.json
initdb -D "$pgdata" -U prc --auth=trust -E UTF8 > /dev/null
pg_ctl -D "$pgdata" -l "$HOME/postgres.log" -w \
  -o "-c listen_addresses=127.0.0.1 -c port=5432 -k /tmp" start
createdb -h 127.0.0.1 -U prc prc

npm run --silent db:migrate
npm run --silent db:seed
npm run --silent demo:populate
npm run --silent demo:emergency
npm run --silent demo:credentials

npm run --silent start -w @prc/api &
npm run --silent worker &
(cd apps/web && exec node ../../node_modules/next/dist/bin/next start \
  --hostname 0.0.0.0 --port "${PORT:-7860}") &

# If any part stops, stop the container so the host restarts it cleanly.
wait -n
echo "A VeriCare process exited; stopping the container." >&2
exit 1
