#!/usr/bin/env bash

echo "Install tiddlywiki"
npm --prefix=./ install tiddlywiki
echo "Clone all submodules"
git submodule init
git submodule sync
git submodule update --remote
echo "Move submodules into correct directory"

if [ -d ./Wikis/BobWiki/plugins ]
then
		rm -r ./Wikis/BobWiki/plugins
fi

mkdir -p ./Wikis/BobWiki/plugins

cp -r ./tiddlygit-plugin ./Wikis/BobWiki/plugins/tiddlygit
cp -r ./plugins_repositories/tw5-relink/plugins/relink/ ./Wikis/BobWiki/plugins/tw5-relink
cp -r ./plugins_repositories/tw5-telmiger-plugins/plugins/telmiger/EditButtons ./Wikis/BobWiki/plugins/tw5-telmiger-plugins

cp -r ./plugins_repositories/TW-Shiraz/source/shiraz ./Wikis/BobWiki/plugins/TW-Shiraz
cp -r ./plugins_repositories/TW-Trashbin/source/trashbin ./Wikis/BobWiki/plugins/TW-Trashbin
cp -r ./plugins_repositories/TW-Commander/source/commander/ ./Wikis/BobWiki/plugins/TW-Commander



