#!/bin/zsh
# Screenshots of the invite email (design A, rendered from lib/invites/email.ts by its test): desktop (600 px email in a 680 px window) and
# phone (390 px), light and dark, via headless Chrome. No server needed.
# usage: emails/invite/shoot.sh [outdir]   (default: .superpowers/invite-email)
set -e
here=${0:A:h}
root=${here:h:h}
out=${1:-$root/.superpowers/invite-email}
mkdir -p "$out"
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
# Phone widths go through frame.html: a macOS Chrome window can't be narrower than ~500 px.
url() { if [ $2 -lt 600 ]; then echo "file://$here/frame.html?src=$1.html&w=$2&h=$3"; else echo "file://$here/$1.html"; fi }
typeset -A heights
heights=(a-desktop 620 a-phone 700)
for v in a; do
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
