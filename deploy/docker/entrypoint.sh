#!/bin/sh
# Entry point of the t.racks Studio image:
#   bridge [options]   the app (default): web interface + bridge, DSPs added from the interface
#   demo               the public demo instance: emulated DSPs, sandbox, automatic resets (docs/demo.md)
#   --option ...       options of the bridge (same as "bridge --option ...")
#   anything else      run as a command (sh, node...)
set -e
cd /app
case "${1:-bridge}" in
  bridge) [ "$#" -gt 0 ] && shift; exec node apps/bridge/src/main.ts "$@" ;;
  demo) shift; exec node deploy/demo/demo.ts "$@" ;;
  -*) exec node apps/bridge/src/main.ts "$@" ;;
  *) exec "$@" ;;
esac
