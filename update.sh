#!/usr/bin/env bash

# See https://github.com/OokTech/TW5-Bob#manual-version

echo "Install tiddlywiki"
npm install tiddlywiki
npm install node-notifier
echo "Clone all submodules"
git submodule init
git submodule update
echo "Move submodules into correct directory"

if [ -d ./Wikis/BobWiki/plugins ]
then
		rm -r ./Wikis/BobWiki/plugins
fi

# cp -r ./plugins_repositories/TW5-Bob/MultiUserWiki/ ./Wikis/BobWiki
mkdir -p ./Wikis/BobWiki/plugins

cp -r ./plugins_repositories/TW5-Bob ./Wikis/BobWiki/plugins/TW5-Bob
cp -r ./plugins_repositories/tw5-relink/plugins/relink/ ./Wikis/BobWiki/plugins/tw5-relink
cp -r ./plugins_repositories/tw5-telmiger-plugins/plugins/telmiger/EditButtons ./Wikis/BobWiki/plugins/tw5-telmiger-plugins

cp -r ./plugins_repositories/TW-Shiraz/source/shiraz ./Wikis/BobWiki/plugins/TW-Shiraz
cp -r ./plugins_repositories/TW-Trashbin/source/trashbin ./Wikis/BobWiki/plugins/TW-Trashbin
cp -r ./plugins_repositories/TW-Commander/source/commander/ ./Wikis/BobWiki/plugins/TW-Commander



