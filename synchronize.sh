#!/usr/bin/env bash

echo "Kill tiddlywiki.jl"
pid=$(pgrep -ofa -x "node ./node_modules/tiddlywiki/tiddlywiki.js Wikis/BobWiki/ --wsserver" | cut -d" " -f 1)
if [ "$pid" != "" ]
then
	kill "$pid"
else
	echo "Pid not found"
fi

git add --all
git commit -m"Synchronize with script"
git fetch
return_code=$?
if [ "$return_code" != 0 ]
then
	notify-send -u critical "Failed fetch : TiddlyWiki serveur stopped"
	exit 1
fi

git merge --no-edit
return_code=$?
echo "Return code=$return_code"

if [ "$return_code" = 0 ]
then
	git add --all
	git commit -m"Commit conflicts"
	git push
	notify-send "Synchronization successful"
	echo "run.sh"
	./run.sh &
else
	notify-send -u critical "Failed merge : TiddlyWiki serveur stopped"
fi
