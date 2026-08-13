#!/bin/sh
set -e

# The mod's base URL, e.g. http://10.0.0.5:2324 (no trailing slash / path).
: "${MOD_UPSTREAM:?MOD_UPSTREAM is required, e.g. http://ae2-mod-host:2324}"

# The gateway service (caching proxy + inventory history). Defaults to the in-cluster service name; the
# Trends view degrades to an explanatory empty state if it is unreachable.
: "${GATEWAY_UPSTREAM:=http://ae2-gateway:8081}"

# Substitute ONLY MOD_UPSTREAM so nginx's own $variables ($host, $uri, ...) survive.
envsubst '${MOD_UPSTREAM} ${GATEWAY_UPSTREAM}' < /etc/nginx/nginx.conf.template > /etc/nginx/conf.d/default.conf

# Remove the stock default server (listens on 80) to avoid a conflict.
rm -f /etc/nginx/conf.d/default.conf.bak 2>/dev/null || true

exec nginx -g 'daemon off;'
