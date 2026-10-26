#!/usr/bin/env bash

git config merge.tiddly-merge.name "merge for TiddlyWiki tiddler files"
git config merge.tiddly-merge.driver "./tiddly-merge.py %O %A %B %P"

./update.sh
