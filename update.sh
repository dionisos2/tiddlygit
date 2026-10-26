#!/usr/bin/env bash

echo "Install tiddlywiki"
npm --prefix=./ install tiddlywiki
echo "Clone all submodules"
git submodule init
git submodule sync
git submodule update --remote
echo "Move submodules into correct directory"

if [ -d ./wiki/plugins ]
then
		rm -r ./wiki/plugins
fi

mkdir -p ./wiki/plugins

cp -r ./tiddlygit-plugin ./wiki/plugins/tiddlygit
cp -r ./plugins_repositories/tw5-relink/plugins/relink/ ./wiki/plugins/tw5-relink
cp -r ./plugins_repositories/tw5-telmiger-plugins/plugins/telmiger/EditButtons ./wiki/plugins/tw5-telmiger-plugins

cp -r ./plugins_repositories/TW-Shiraz/source/shiraz ./wiki/plugins/TW-Shiraz
cp -r ./plugins_repositories/TW-Trashbin/source/trashbin ./wiki/plugins/TW-Trashbin
cp -r ./plugins_repositories/TW-Commander/source/commander/ ./wiki/plugins/TW-Commander



