#!/usr/bin/env bash
echo "=== script start ==="
echo "local: about to ssh to Pi..."

ssh magnus@huginmunin.local 'F=/home/magnus/munin-memory/.env; echo "remote: env file:"; ls -l "$F"; K=$(grep "^OPENROUTER_API_KEY" "$F" | cut -d= -f2- | tr -d "\"'\''" ); echo "remote: key length ${#K}"; echo "remote: /credits response:"; curl -sS -w "\nHTTP=%{http_code}\n" https://openrouter.ai/api/v1/credits -H "Authorization: Bearer $K"; echo "remote: /auth/key response:"; curl -sS -w "\nHTTP=%{http_code}\n" https://openrouter.ai/api/v1/auth/key -H "Authorization: Bearer $K"'

echo "local: ssh exited with code $?"
echo "=== script end ==="
