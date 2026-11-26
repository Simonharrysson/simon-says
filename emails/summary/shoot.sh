#!/bin/zsh
# Screenshots of the summary e-mail (lib/summaries/email.ts, demo data in ./demo.ts): desktop
# (600 px email in a 680 px window) and phone (390 px), light and dark, via headless Chrome.
# usage: emails/summary/shoot.sh [outdir]   (default: .superpowers/meeting-summary)
set -e
here=${0:A:h}
root=${here:h:h}
out=${1:-$root/.superpowers/meeting-summary}
mkdir -p "$out"
(cd "$root" && npx tsx emails/summary/render.ts "$out")
cp "$here/frame.html" "$out/frame.html"
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
url() { if [ $2 -lt 600 ]; then echo "file://$out/frame.html?src=$1.html&w=$2&h=$3"; else echo "file://$out/$1.html"; fi }
typeset -A heights
heights=(missed-desktop 1240 missed-phone 1460 admin-desktop 1000 admin-phone 1180 short-desktop 700 short-phone 820)
for v in missed admin short; do
  for dev in desktop:680 phone:390; do
    d=${dev%%:*}; w=${dev##*:}; h=${heights[$v-$d]}
    "$CH" --headless=new --disable-gpu --hide-scrollbars --window-size=$w,$h \
      --blink-settings=preferredColorScheme=1 \
      --screenshot="$out/$v-$d-light.png" "$(url $v $w $h)" >/dev/null 2>&1
    "$CH" --headless=new --disable-gpu --hide-scrollbars --window-size=$w,$h \
      --force-dark-mode --blink-settings=preferredColorScheme=0 \
      --screenshot="$out/$v-$d-dark.png" "$(url $v $w $h)" >/dev/null 2>&1
  done
done
ls "$out"
