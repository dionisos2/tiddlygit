#!/usr/bin/env bash

git submodule add https://github.com/OokTech/TW5-Bob.git plugins_repositories/TW5-Bob
git submodule add https://github.com/kookma/TW-Shiraz.git plugins_repositories/TW-Shiraz
git submodule add https://github.com/flibbles/tw5-relink.git plugins_repositories/tw5-relink
git submodule add https://github.com/kookma/TW-Trashbin plugins_repositories/TW-Trashbin
git submodule add https://github.com/kookma/TW-Commander.git plugins_repositories/TW-Commander
git submodule add https://github.com/rimi/tw5-telmiger-plugins plugins_repositories/tw5-telmiger-plugins

git config merge.tiddly-merge.name "merge for TiddlyWiki tid files"
git config merge.tiddly-merge.driver "tiddly-merge.py %O %A %B"

./update.sh
