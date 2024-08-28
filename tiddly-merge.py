#!/usr/bin/env python3

import sys
import os
import difflib
import subprocess


class Env:
	def __init__(self, base_path, ours_path, theirs_path, ):
		self.tid_path = "./Wikis/planning/tiddlers/"
		self.base_path = base_path
		self.ours_path = ours_path
		self.theirs_path = theirs_path

		self.unimp = ["modified",
									"created",
									"nouvelle-tache",
									"fields-to-show",
									"date-start",
									"date-start-temp",
									"days-count",
									"days-count-temp",
									"show-day-record"]

		with open(ours_path, 'r') as ours_file:
			self.ours_str = ours_file.read()

		with open(theirs_path, 'r') as theirs_file:
			self.theirs_str = theirs_file.read()


if len(sys.argv) != 4:
	print("Should take 4 arguments : %O %A %B")
	sys.exit(1)
else:
	current_env = Env(sys.argv[1], sys.argv[2], sys.argv[3])


def create_tiddler(env, name, string):
	tiddler_path = os.path.realpath(env.tid_path + name)
	with open(tiddler_path, "w") as tiddler_file:
		tiddler_file.write(string)


def set_tiddler(env, string):
	with open(env.ours_path, "w") as merged_file:
		merged_file.write(string)


def unimportant(env, string):
	return any(string.startswith("+ " + value) or string.startswith("- " + value) for value in env.unimp)

def check_diff(env):
	differ = difflib.Differ()
	result = differ.compare(env.ours_str.splitlines(keepends=True), env.theirs_str.splitlines(keepends=True))
	result = [line for line in result if line[0] in ["+", "-"]] # Check only modifications
	result = [line for line in result if not unimportant(env, line)]
	print("Number of changes:", len(result))
	return len(result) > 0


def get_title(tiddler):
	for line in tiddler.splitlines():
		if line.startswith("title:"):
			return line[6:].strip()
	return "NONAME"


def add_to(field, tiddler, value):
	"""
	Add value to the field of tiddler.
	Do nothing if the field is not found.
	"""
	new_tiddler = []
	found = False
	for line in tiddler.splitlines():
		if line.startswith(field+":") and not found:
			new_tiddler.append(line.strip() + value)
			found = True
		else:
			new_tiddler.append(line)

		if line == "": # After that we are in the text field
			found = True

	return "\n".join(new_tiddler)


def run(command):
	return subprocess.run(command, stdout=subprocess.PIPE).stdout.decode('utf-8')

def create_conflit_tiddler(env):
	ours_user = run(["git", "config", "user.name"])
	theirs_user = run(["git", "show", "-s", "--format=%an", "remotes/origin/HEAD"])

	ours_tiddler = env.ours_str
	ours_title = get_title(ours_tiddler)
	suffix = str(hash(env.theirs_str))
	theirs_title = ours_title+suffix

	ours_tiddler = ours_tiddler + f"\n\nCONFLIT : [[{theirs_title}]] (modified by : {theirs_user})"
	set_tiddler(env, ours_tiddler)

	theirs_tiddler = env.theirs_str
	theirs_tiddler = add_to("title", theirs_tiddler, suffix)
	theirs_tiddler = add_to("tags", theirs_tiddler, " GitConflit")
	theirs_tiddler += f"\n\nCONFLIT : [[{ours_title}]] (modified by : {ours_user})"
	create_tiddler(env, theirs_title+".tid", theirs_tiddler)


def main(env):
	print("current_dir: ", os.getcwd())
	print("tid_path: ", os.path.realpath(env.tid_path))

	if check_diff(env):
		create_conflit_tiddler(env)

	return 0

main(current_env)
