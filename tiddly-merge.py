#!/usr/bin/env python3
"""
Git merge driver for TiddlyWiki tiddler files (.tid and .json).

Usage (configured by installation.sh): tiddly-merge.py %O %A %B

The tiddlers are merged field by field: a field changed on one side only takes
that value, and when both sides changed the text, it is merged line by line.
When both sides changed the same field differently, our version is kept, and
their version is saved as a new tiddler tagged GitConflict, each one linking to
the other. Conflicts on unimportant fields are ignored (our value is kept).

Files that are not tiddlers (like plugin .json files) are merged line by line,
like git does by default.
"""

import json
import os
import re
import subprocess
import sys
import tempfile

TID_PATH = "./wiki/tiddlers/"

UNIMPORTANT_FIELDS = [
	"modified",
	"created",
	"nouvelle-tache",
	"fields-to-show",
	"date-start",
	"date-start-temp",
	"days-count",
	"days-count-temp",
	"show-day-record",
]

TID, JSON = "tid", "json"


def parse_tid(content):
	"""Parse a .tid file the way TiddlyWiki does."""
	fields = {}
	parts = re.split(r"\r?\n\r?\n", content)
	for line in re.split(r"\r?\n", parts[0]):
		if line.startswith("#"):
			continue
		name, colon, value = line.partition(":")
		if colon and name.strip():
			fields[name.strip()] = value.strip()
	if len(parts) >= 2:
		fields["text"] = "\n\n".join(parts[1:])
	return fields


def parse(content):
	"""
	Return (format, fields) for a file holding one tiddler, or None.
	The format is found from the content, so that a tiddler saved as .tid on
	one side and as .json on the other can still be merged.
	"""
	if content.lstrip().startswith(("[", "{")):
		try:
			data = json.loads(content)
		except ValueError:
			return None
		if isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict) \
				and all(isinstance(value, str) for value in data[0].values()):
			return JSON, data[0]
		return None
	fields = parse_tid(content)
	return (TID, fields) if fields.get("title") else None


def serialize(file_format, fields):
	"""Write a tiddler the way TiddlyWiki does."""
	if file_format == JSON:
		return json.dumps([fields], indent=4, ensure_ascii=False)
	header = "\n".join(f"{name}: {fields[name]}" for name in sorted(fields) if name not in ("text", "bag"))
	text = fields.get("text", "")
	return header + ("\n\n" + text if text else "")


def has_unsafe_fields(fields):
	"""Whether the tiddler cannot be saved as a .tid file (see TiddlyWiki's generateTiddlerFileInfo)."""
	return any(
		re.search(r"[\x00-\x1F]", value) or value.strip() != value or re.search(r"[:#]", name)
		for name, value in fields.items() if name != "text"
	)


def merge_lines(base, ours, theirs):
	"""Merge three texts line by line, return the result or None on conflict."""
	with tempfile.TemporaryDirectory() as folder:
		paths = []
		for name, content in (("ours", ours), ("base", base), ("theirs", theirs)):
			path = os.path.join(folder, name)
			with open(path, "w") as file:
				file.write(content)
			paths.append(path)
		result = subprocess.run(["git", "merge-file", "-p", "--quiet"] + paths, stdout=subprocess.PIPE)
	return result.stdout.decode("utf-8") if result.returncode == 0 else None


def merge_fields(base, ours, theirs):
	"""
	Merge the fields of three versions of a tiddler.
	Return the merged fields (in the order of ours) and the conflicting field names.
	"""
	merged = {}
	conflicts = []
	names = list(ours) + [name for name in list(theirs) + list(base) if name not in ours]
	for name in dict.fromkeys(names):
		base_value, ours_value, theirs_value = base.get(name), ours.get(name), theirs.get(name)
		if ours_value == theirs_value or theirs_value == base_value:
			value = ours_value
		elif ours_value == base_value:
			value = theirs_value
		elif name in UNIMPORTANT_FIELDS:
			value = ours_value
		else:
			value = None
			if name == "text" and ours_value is not None and theirs_value is not None:
				value = merge_lines(base_value or "", ours_value, theirs_value)
			if value is None:
				value = ours_value
				conflicts.append(name)
		if value is not None:
			merged[name] = value
	# Fields only in theirs come after the fields of ours
	return merged, conflicts


def run(command):
	return subprocess.run(command, stdout=subprocess.PIPE).stdout.decode("utf-8").strip()


def add_conflict_note(fields, title, user):
	note = f"CONFLICT : [[{title}]] (modified by : {user})"
	fields["text"] = (fields.get("text", "") + "\n\n" + note).lstrip("\n")


def save_conflict_copy(file_format, fields, suffix):
	"""Save their version as a new tiddler, return its title."""
	copy = dict(fields)
	copy["title"] = fields["title"] + suffix
	copy["tags"] = (fields.get("tags", "") + " GitConflict").strip()
	if has_unsafe_fields(copy):
		file_format = JSON
	filename = re.sub(r'[<>:"/\\|?*^]', "_", copy["title"]) + (".json" if file_format == JSON else ".tid")
	with open(os.path.join(TID_PATH, filename), "w") as file:
		file.write(serialize(file_format, copy))
	return copy


def merge_tiddler_file(base_path, ours_path, theirs_path):
	contents = []
	for path in (base_path, ours_path, theirs_path):
		with open(path) as file:
			contents.append(file.read())
	base_content, ours_content, theirs_content = contents
	ours, theirs = parse(ours_content), parse(theirs_content)
	base = parse(base_content) if base_content.strip() else (TID, {})
	if ours is None or theirs is None or base is None:
		# Not a tiddler file, do what git does by default
		return subprocess.run(["git", "merge-file", ours_path, base_path, theirs_path]).returncode

	file_format = ours[0]
	merged, conflicts = merge_fields(base[1], ours[1], theirs[1])
	if conflicts:
		print(f"Conflict on the fields {', '.join(conflicts)} of {ours[1]['title']}")
		ours_user = run(["git", "config", "user.name"])
		theirs_user = run(["git", "show", "-s", "--format=%an", "remotes/origin/HEAD"])
		theirs_fields = dict(theirs[1])
		add_conflict_note(theirs_fields, merged["title"], ours_user)
		copy = save_conflict_copy(theirs[0], theirs_fields, str(hash(theirs_content)))
		add_conflict_note(merged, copy["title"], theirs_user)
	# Git expects the result in the same file, so the format of ours is kept
	with open(ours_path, "w") as file:
		file.write(serialize(file_format, merged))
	return 0


if __name__ == "__main__":
	if len(sys.argv) != 4:
		print("Should take 3 arguments : %O %A %B")
		sys.exit(1)
	sys.exit(merge_tiddler_file(*sys.argv[1:]))
