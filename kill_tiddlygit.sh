#!/usr/bin/env bash

echo "Kill tiddlywiki.jl"
pid=$(pgrep -ofa -x "node ./node_modules/tiddlywiki/tiddlywiki.js Wikis/BobWiki/ --wsserver" | cut -d" " -f 1)
if [ "$pid" != "" ]
then
	kill "$pid"
else
	echo "Pid not found"
fi
