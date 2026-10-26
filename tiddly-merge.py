#!/usr/bin/env python3
"""
Git merge driver for TiddlyWiki tiddler files (.tid and .json).

Usage (configured by installation.sh): tiddly-merge.py %O %A %B

The tiddlers are merged field by field: a field changed on one side only takes
that value, and when both sides changed the text, it is merged line by line.
When both sides changed the same field differently, our version is kept, and
their version is saved as a new tiddler tagged GitConflict, each one linking to
the other. Conflicts on unimportant fields are ignored (our value is kept).

Other .json files (like plugins) are merged structurally: objects key by key,
arrays element by element and strings line by line. When this is not possible
(conflict, or formatting that cannot be kept), files are merged line by line
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


class MergeConflict(Exception):
	pass


# A key missing from a json object
MISSING = object()


def same(a, b):
	"""Strict json equality (in Python, True == 1)."""
	if a is MISSING or b is MISSING:
		return a is b
	return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def merge_values(base, ours, theirs):
	"""Three-way merge of json values, raise MergeConflict when it is not possible."""
	if same(ours, theirs) or same(theirs, base):
		return ours
	if same(ours, base):
		return theirs
	if isinstance(ours, dict) and isinstance(theirs, dict):
		base = base if isinstance(base, dict) else {}
		merged = {}
		for key in dict.fromkeys(list(ours) + list(theirs)):
			value = merge_values(base.get(key, MISSING), ours.get(key, MISSING), theirs.get(key, MISSING))
			if value is not MISSING:
				merged[key] = value
		return merged
	if isinstance(ours, str) and isinstance(theirs, str):
		merged = merge_lines(base if isinstance(base, str) else "", ours, theirs)
		if merged is None:
			raise MergeConflict()
		return merged
	if isinstance(ours, list) and isinstance(theirs, list):
		# Merge the elements like lines (a compact json value has no line break)
		def as_lines(values):
			return "".join(json.dumps(value, ensure_ascii=False) + "\n" for value in values)
		merged = merge_lines(as_lines(base if isinstance(base, list) else []), as_lines(ours), as_lines(theirs))
		if merged is None:
			raise MergeConflict()
		return [json.loads(line) for line in merged.splitlines()]
	raise MergeConflict()


def json_format(content):
	"""Return the json.dumps options and the ending reproducing content exactly, or None."""
	data = json.loads(content)
	ending = content[len(content.rstrip("\n")):]
	for ensure_ascii in (False, True):
		for indent in (4, 2, "\t", None, 1, 3, 8):
			options = {"indent": indent, "ensure_ascii": ensure_ascii}
			if indent is None:
				options["separators"] = (",", ":")
			if json.dumps(data, **options) + ending == content:
				return options, ending
	return None


def merge_json_file(base_content, ours_content, theirs_content):
	"""
	Merge json files structurally, return the result or None when it is not
	possible (invalid json, conflict, or formatting that cannot be kept).
	"""
	try:
		result_format = json_format(ours_content)
		if result_format is None:
			return None
		base = json.loads(base_content) if base_content.strip() else MISSING
		merged = merge_values(base, json.loads(ours_content), json.loads(theirs_content))
	except (ValueError, MergeConflict):
		return None
	options, ending = result_format
	return json.dumps(merged, **options) + ending


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
		# Not a tiddler file
		merged = merge_json_file(base_content, ours_content, theirs_content)
		if merged is None:
			# Do what git does by default
			return subprocess.run(["git", "merge-file", ours_path, base_path, theirs_path]).returncode
		with open(ours_path, "w") as file:
			file.write(merged)
		return 0

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
