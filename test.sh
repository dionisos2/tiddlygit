#!/usr/bin/env bash
set -euo pipefail

# 📦 Variables
# The version tested is the one committed in this repository (not the
# uncommitted changes), so that the changes can be tested before pushing them
REPO=$(cd "$(dirname "$0")" && git rev-parse --show-toplevel)
BRANCH=$(git -C "$REPO" symbolic-ref --short HEAD) || { echo "❌ Check out a branch to test it"; exit 1; }
mkdir -p "./test_tmp"
WORKDIR=$(readlink -f "./test_tmp")
ORIGIN="$WORKDIR/tiddlygit-origin.git"
CLONE="$WORKDIR/tiddlygit"
# Not the port of run.sh, so that a TiddlyGit server already running is neither
# tested nor killed instead of the test one
PORT=7171
SERVER_PID=""

kill_tiddlywiki() {
  if [ -n "$SERVER_PID" ]; then
    echo "Killing the test server"
    kill "$SERVER_PID" 2> /dev/null || true
    SERVER_PID=""
  fi
}

cleanup() {
  echo "🧹 Cleaning up..."
	set +e
  kill_tiddlywiki
}
trap cleanup EXIT

echo "📁 Temporary working directory: $WORKDIR"

# 1. 💾 Bare mirror of this repository, used as the remote of the test clone
# (synchronize.sh pushes to it, not to this repository nor to its remote)
echo "🔧 Copying $REPO ($BRANCH) to a bare repository"
rm -rf "$ORIGIN"
git clone -q --bare "$REPO" "$ORIGIN"

# 2. 📥 Test clone, kept between runs to avoid installing everything again
if [[ -d "$CLONE/.git" ]]; then
  echo "🔄 Resetting the test clone to $BRANCH"
  git -C "$CLONE" remote set-url origin "$ORIGIN"
  git -C "$CLONE" fetch -q origin
  git -C "$CLONE" checkout -q -f -B "$BRANCH" "origin/$BRANCH"
  # The ignored files (node_modules, wiki/plugins...) are kept
  git -C "$CLONE" clean -q -fd
else
  echo "📥 Cloning for testing"
  git clone -q -b "$BRANCH" "$ORIGIN" "$CLONE"
fi
cd "$CLONE"

# 3. 🛠 Installation and server
echo "📦 Installation"
chmod +x installation.sh run.sh synchronize.sh
./installation.sh

echo "🚀 Starting the TiddlyGit server"
./run.sh port=$PORT &
SERVER_PID=$!
sleep 1  # initial wait
# Wait via port check + ensure server is available
for i in {1..20}; do
  curl -fs "http://localhost:$PORT/" > /dev/null && break
  sleep 1
  echo "⏳ Waiting for the server..."
done
curl -fs "http://localhost:$PORT/" > /dev/null || { echo "❌ Server did not start"; exit 1; }
echo "✅ Server is up"

# 4. 🧪 Conflict management test

echo "🧪 Creating conflict management"

cd "$CLONE"
# Create a test tiddler
printf "\n\nbob conflict" >> wiki/tiddlers/test.tid

# 1st synchronization (initial push)
./synchronize.sh

# Reset to previous HEAD state
git reset --hard HEAD^

# Simulate conflict
printf "\n\ninstance conflict" >> wiki/tiddlers/test.tid

# 2nd call => should trigger a conflict
./synchronize.sh || true
kill_tiddlywiki

# 🕵️‍♂️ Verify the file created by tiddly-merge
echo "📁 Searching for tiddlers tagged with GitConflict..."
CONFLICT_FILES=$(grep -lR "GitConflict" wiki/tiddlers/ | grep -v "/GitConflict.tid$" || true)

if [[ -z "${CONFLICT_FILES:-}" ]]; then
  echo "❌ No tiddler with GitConflict tag found — merge driver did not work"
  exit 1
fi

echo "✅ Merge driver generated the following files:"
echo "$CONFLICT_FILES"
echo "Deleting $WORKDIR"
rm -rf "$WORKDIR"
echo "✅ Test completed successfully"
