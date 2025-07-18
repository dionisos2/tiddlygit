# Introduction

A TiddlyWiki/TiddlyBob configured to work collaboratively through git.
I did it for my personal use case, and it is probably not the correct way to do it, but feel free to try it or to take some parts of it as an inspiration.
The goal is to have a button inside the Wiki that you can click to commit and push your changes and which take care of conflicts.


## Notes

The TiddlyWiki server will be closed and restarted each time you use the synchronization button. This was necessary because otherwise the Bob plugin could modify the files during the git commands, leading to data lost.

After a completed synchronization, you should reload the browser page (F5) to get the last changes loaded inside it.

If there is any problem during the synchronization, it will stop, and you will have to look inside the console what is happening with git.

Don't hesitate to create an issue if you have a question or if there is any problem.

J’utilise des plugins, comme par exemple "Edit Buttons" de telminger : https://tid.li/tw5/plugins.html#%24%3A%2Fplugins%2Ftelmiger%2FEditButtons

## Merge and Conflicts

First any conflicts on these fields will simply be ignored: "modified", "created", "nouvelle-tache", "fields-to-show", "date-start", "date-start-temp", "days-count", "days-count-temp", "show-day-record".
(see tiddly-merge.py)
The goal is to avoid useless conflicts for unimportant field (in particular the field "modified")
Then, any tiddler with remaining conflicts will be duplicated (one for each version), with added link at the bottom in each one referencing the other one, they will also be tagged with the GitConflict tag.
You can then simply remove/edit these tiddlers before commiting/pushing again with the GitHub button.

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
Wikis/BobWiki/tiddlers/test-766755633815162457.tid
Deleting /home/dionisos/projets/programmation/tiddlygit/test_tmp
Terminated
✅ Test completed successfully
🧹 Cleaning up...
Killing tiddlywiki.jl
PID not found
```

If the test doesn't complete successfully, please verify the dependencies, and then create an issue.

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
(you can change the port in Wikis/BobWiki/settings/settings.json)

While you are working on your wiki, you can click the button with a GitHub icon to synchronize your work with the remote repository (you should reload the browser page after doing it to get the last modifications).
