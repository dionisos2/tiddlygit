#!/usr/bin/env bash

echo "Kill tiddlywiki.js"
pid=$(pgrep -of "node ./node_modules/tiddlywiki/tiddlywiki.js wiki/ --listen")
if [ "$pid" != "" ]
then
	kill "$pid"
else
	echo "Pid not found"
fi
