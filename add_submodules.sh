#!/usr/bin/env bash

git submodule add https://github.com/kookma/TW-Shiraz.git plugins_repositories/TW-Shiraz
git submodule add https://github.com/flibbles/tw5-relink.git plugins_repositories/tw5-relink
git submodule add https://github.com/kookma/TW-Trashbin plugins_repositories/TW-Trashbin
git submodule add https://github.com/kookma/TW-Commander.git plugins_repositories/TW-Commander
git submodule add https://github.com/rimi/tw5-telmiger-plugins plugins_repositories/tw5-telmiger-plugins

# Each wiki may use other versions of the plugins (update.sh takes their latest
# version): git ignores the commit the submodules point to
for name in $(git config -f .gitmodules --name-only --get-regexp '\.path$' | sed 's/\.path$//'); do
	git config -f .gitmodules "$name.ignore" all
done
