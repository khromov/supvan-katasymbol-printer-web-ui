#!/bin/sh
# Runs the E10/T10 test scenarios (scripts/test-t15.ts) through the SUPRINT app's own print code
# and records the result as the golden digests the plain test run checks.
#
# Usage: scripts/suprint-oracle/run.sh <SUPRINT .xapk or .apk>   (tested with SUPRINT 1.5.0)
# Needs a JDK, dex2jar (brew install dex2jar) and python3 (the emulator decodes LZMA with it).
# Work files go to $SUPRINT_ORACLE_DIR (default $TMPDIR/suprint-oracle).
#
# The app's classes run unmodified from its dex (converted with dex2jar); the Java files here only
# stand in for Android and the app's singletons, and emulate the printer (harness/Emu.java, the
# twin of scripts/t15-emulator.ts).
set -e
here=$(cd "$(dirname "$0")" && pwd)
work=${SUPRINT_ORACLE_DIR:-${TMPDIR:-/tmp}/suprint-oracle}
apk=$1
[ -n "$apk" ] || { echo "usage: $0 <SUPRINT .xapk or .apk>" >&2; exit 1; }
mkdir -p "$work"
case "$apk" in
*.xapk)
	unzip -o -q "$apk" com.supvan.IPrinterEn.apk -d "$work"
	apk=$work/com.supvan.IPrinterEn.apk
	;;
esac
d2j-dex2jar -f -o "$work/app.jar" "$apk" >/dev/null
rm -rf "$work/classes" "$work/scenarios"
mkdir -p "$work/classes"
javac -nowarn -cp "$work/app.jar" -d "$work/classes" $(find "$here" -name '*.java')
npx tsx "$here/../test-t15.ts" --scenarios "$work/scenarios"
java -cp "$work/classes:$work/app.jar" harness.Main "$work/scenarios"
npx tsx "$here/../test-t15.ts" --oracle "$work/scenarios"
