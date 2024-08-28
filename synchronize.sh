#!/usr/bin/env bash

git add --all
git commit -m"Synchronize with script"
git fetch
git merge --no-edit
git add --all
git commit -m"Commit conflicts"
git push
