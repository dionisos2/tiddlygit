#!/usr/bin/env bash

# Extra parameters are given to --listen, and override these ones (./run.sh port=8080)
exec node ./node_modules/tiddlywiki/tiddlywiki.js wiki/ --listen port=7070 host=127.0.0.1 "$@"
