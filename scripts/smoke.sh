#!/usr/bin/env bash
set -euo pipefail
# This isolated network has no external route. No live EVE/SSO credentials,
# SDE download, telemetry or production database are involved in smoke checks.
cleanup() {
  status=$?
  if (( status != 0 )); then
    docker logs nexum-smoke-server || true
    docker logs nexum-smoke-web || true
  fi
  docker rm -f nexum-smoke-web nexum-smoke-server nexum-smoke-db >/dev/null 2>&1 || true
  docker network rm nexum-smoke >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
docker network create --internal nexum-smoke
docker run -d --name nexum-smoke-db --network nexum-smoke --network-alias db \
  -e POSTGRES_USER=nexum -e POSTGRES_PASSWORD=smoke-only -e POSTGRES_DB=nexum_smoke postgres:16
ready=false
for i in {1..30}; do
  if docker exec nexum-smoke-db pg_isready -U nexum -d nexum_smoke; then ready=true; break; fi
  sleep 2
done
[[ "$ready" == true ]]
# Use upstream's own empty SDE test schema plus the stargate table needed at boot.
node <<'NODE' > smoke-schema.sql
const fs = require('fs');
const text = fs.readFileSync('source/server/src/test/integrationDb.ts', 'utf8');
const ddl = text.match(/const SDE_DDL = `([\s\S]*?)`;/);
if (!ddl) throw new Error('Upstream SDE fixture changed; review smoke setup.');
console.log(ddl[1]);
console.log('CREATE TABLE map_stargates (id INTEGER PRIMARY KEY, system_id INTEGER NOT NULL, destination_gate_id INTEGER NOT NULL, destination_system_id INTEGER NOT NULL);');
NODE
docker exec -i nexum-smoke-db psql -v ON_ERROR_STOP=1 -U nexum -d nexum_smoke < smoke-schema.sql
docker run -d --name nexum-smoke-server --network nexum-smoke --network-alias server \
  -e NODE_ENV=production -e PORT=3001 -e PG_HOST=db -e PG_DB=nexum_smoke \
  -e PG_USER=nexum -e PG_PASSWORD=smoke-only -e SESSION_SECRET=ci-smoke-session-not-for-deployment \
  -e TOKEN_ENCRYPTION_KEY=ci-smoke-encryption-key-not-for-deployment \
  -e EVE_CLIENT_ID=smoke-placeholder -e EVE_CLIENT_SECRET=smoke-placeholder \
  -e FRONTEND_URL=http://localhost -e SDE_AUTO_UPDATE=0 -e INCLUDE_DEMO_MAP=0 \
  -e NEXUM_TELEMETRY_URL=http://127.0.0.1:9 nexum-server:tested
ready=false
for i in {1..60}; do
  if docker exec nexum-smoke-server node -e 'fetch("http://127.0.0.1:3001/health").then(async r=>{if(!r.ok || !(await r.json()).ok)process.exit(1)}).catch(()=>process.exit(1))'; then ready=true; break; fi
  sleep 2
done
[[ "$ready" == true ]]
docker run -d --name nexum-smoke-web --network nexum-smoke --network-alias web \
  -e API_PORT=3001 nexum-web:tested
ready=false
for i in {1..30}; do
  if docker exec nexum-smoke-server node -e 'fetch("http://web/").then(async r=>{if(!r.ok || !(await r.text()).includes("<div id=\"root\""))process.exit(1)}).catch(()=>process.exit(1))'; then ready=true; break; fi
  sleep 2
done
[[ "$ready" == true ]]
docker exec nexum-smoke-web nginx -t
docker exec nexum-smoke-server node -e 'fetch("http://web/auth/me").then(async r=>{const b=await r.json();if(!r.ok || b.user!==null)process.exit(1)}).catch(()=>process.exit(1))'
docker exec nexum-smoke-server test -f /app/dist/scripts/setup-db.js
echo 'Server migration/startup/health, importer presence, web HTML and API proxy passed.'
