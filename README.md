# Introduction

A TiddlyWiki configured to work collaboratively through git.
I did it for my personal use case, and it is probably not the correct way to do it, but feel free to try it or to take some parts of it as an inspiration.
The goal is to have a button inside the Wiki that you can click to commit and push your changes and which take care of conflicts.

# Quick guide

- installs TiddlyGit
- test everything is working with `test.sh`
- start the server with the `run.sh`
- navigate to http://127.0.0.1:7070/
- press the "github" button - this will commit your changes, merge the changes of the other contributors and push them
- a notification tells you when the synchronization is done, the merged changes appear in the browser without reloading the page

## Notes

The server is the TiddlyWiki node.js server (`--listen`), with the tiddlygit plugin (see `tiddlygit-plugin/`) which:
- loads the tiddler files created, modified or deleted on disk (by a text editor, git...), they reach the browser within 5 seconds,
- runs `synchronize.sh` when the synchronization button is pressed. The server doesn't write any file while the script runs, and reloads the files changed by git when it ends.

If there is any problem during the synchronization, the notification says so, and the output of git is in the `$:/temp/tiddlygit/synchronize` tiddler.

Don't hesitate to create an issue if you have a question or if there is any problem.

J’utilise des plugins, comme par exemple "Edit Buttons" de telminger : https://tid.li/tw5/plugins.html#%24%3A%2Fplugins%2Ftelmiger%2FEditButtons

## Merge and Conflicts

The tiddler files (.tid and .json) are merged field by field by tiddly-merge.py:
- a field changed on one side only takes the value of that side, even when both sides changed other fields,
- when both sides changed the text, it is merged line by line,
- conflicts on these unimportant fields are ignored (your value is kept): "modified", "created", "nouvelle-tache", "fields-to-show", "date-start", "date-start-temp", "days-count", "days-count-temp", "show-day-record".

Then, any tiddler with remaining conflicts will be duplicated (one for each version), with added link at the bottom in each one referencing the other one, they will also be tagged with the GitConflict tag.
You can then simply remove/edit these tiddlers before commiting/pushing again with the GitHub button.

TiddlyWiki saves a tiddler as .json when one of its fields has leading or trailing spaces. The tiddlygit plugin then keeps it as .json, and synchronize.sh merges a tiddler saved as .json on one side and as .tid on the other (`tiddly-merge.py --resolve-format-changes`).

The other .json files are merged structurally: objects key by key, arrays element by element and strings line by line. When this is not possible (conflict, or formatting that cannot be kept), they are merged line by line like git does by default.

Some particular tiddlers are also completely ignored, see the .gitignore file.


# Dependencies

* git
* nodejs
* npm
* python3
* libnotify

## On Archlinux

`sudo pacman -S git nodejs npm python libnotify`

## On Ubuntu

`sudo apt install git-all nodejs npm python3 libnotify-bin notify-osd`

# Test

To test that everything will work correctly on your computer, run the command `./test.sh`, it should end with these messages :

```console
✅ Merge driver generated the following files:
wiki/tiddlers/test-766755633815162457.tid
Deleting /home/dionisos/projets/programmation/tiddlygit/test_tmp
Terminated
✅ Test completed successfully
🧹 Cleaning up...
Killing tiddlywiki.jl
PID not found
```

If the test doesn't complete successfully, please verify the dependencies, and then create an issue.

The server and the tiddlygit plugin are tested with `node --test tests/`.

# Installation

Preferred way :

`git clone https://github.com/dionisos2/tiddlygit.git`
Then modify tiddlygit/.git/config to change the remote link.

or

Fork https://github.com/dionisos2/tiddlygit on GitHub
Then `git clone your_fork`

Then

```
cd tiddlygit
installation.sh
```

## Update

```
git remote add upstream https://github.com/dionisos2/tiddlygit.git
git fetch upstream
git merge upstream/master
update.sh
```

### Coming from the old `Wikis/<name>/` layout (Bob plugin)

The wiki is now in the `wiki/` folder (`wiki/tiddlywiki.info`, `wiki/tiddlers/`), like a basic node.js TiddlyWiki. To convert a wiki in the old layout, stop the server (`pkill -f "tiddlywiki.js Wikis/"`), commit your changes, then:

```
git fetch upstream
git -c merge.directoryRenames=true merge upstream/master
./convert_wiki_folder.sh
git commit -m "Move the wiki to wiki/"
./update.sh
```

`merge.directoryRenames=true` lets git move the tiddlers you created to `wiki/tiddlers/` during the merge. `convert_wiki_folder.sh` then:
- moves the remaining files, including the local files ignored by git (`PersonalConfiguration.tid`, `$:/config/...`),
- keeps your `tiddlywiki.info`,
- removes what belonged to Bob (`settings/`, `$:/Bob/EditingTiddlers`...),
- updates `.gitignore`.

If you have several wikis in `Wikis/`, give the one to convert: `./convert_wiki_folder.sh Wikis/<name>`.
If a file exists in both folders with a different content, the script stops without changing anything and lists these files.
The git history of a tiddler is still available with `git log --follow wiki/tiddlers/<file>`.

# Usage

## Only having to enter your credential one time
### If you use SSH to connect to your repo (preferred way)

```
eval "$(ssh-agent -s)" && ssh-add ~/.ssh/id_rsa
```

### If you use your login and password to connect to your repo

```
git config --global credential.helper store
```
This will create a `~/.git-credentials` where the password is in clear (https://git-scm.com/docs/gitcredentials).

If you don't want your password to be stored in plain text, you can use this instead :

```
git config credential.helper 'cache --timeout=3600'
```

## Starting the server

Then start the server with `run.sh` and  open http://localhost:7070/ in a WebBrowser.
(you can change the port in run.sh)

While you are working on your wiki, you can click the button with a GitHub icon to synchronize your work with the remote repository.
