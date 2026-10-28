#!/bin/sh
set -eu
# The persistent mount may initially belong to root. Only bootstrap needs root;
# the application and all of its credential/database files run as the node user.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /var/data
  chown node:node /var/data
  exec gosu node "$@"
fi
exec "$@"
