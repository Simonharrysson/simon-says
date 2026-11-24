#!/bin/zsh
# Runs the whole Task 0 spike. Needs ELEVENLABS_API_KEY in env or SPIKE_ENV_FILE.
# Private outputs go to $PRIV (never the repo). ~3.6 audio-hours total.
set -e
REPO=${0:A:h:h}; PRIV=${PRIV:-$HOME/simon-says-private/spike-logs}; P=$PRIV/pcm
export SPIKE_TALLY=$PRIV/audio-hours.tsv
S="node $REPO/spike/stream.mjs"
A="$HOME/simon-says-private/audio/vanadis-gummi.m4a"
mkdir -p $P
[ -f $P/full.pcm ] || ffmpeg -nostdin -loglevel error -y -i $A -ac 1 -ar 16000 -f s16le $P/full.pcm
for s in 600 2400 4200; do [ -f $P/ex_$s.pcm ] || ffmpeg -nostdin -loglevel error -y -ss $s -t 300 -i $A -ac 1 -ar 16000 -f s16le $P/ex_$s.pcm; done
[ -f $P/recon_1200.pcm ] || ffmpeg -nostdin -loglevel error -y -ss 1200 -t 600 -i $A -ac 1 -ar 16000 -f s16le $P/recon_1200.pcm
case "$1" in
  smoke)   $S --pcm $P/ex_600.pcm --out $PRIV/smoke.jsonl --limit-sec 60 --commit vad --max-session 600 ;;
  compare) # same excerpt, three strategies concurrently; replicate on a second excerpt
    $S --pcm $P/ex_600.pcm --out $PRIV/cmp_vad_600.jsonl --commit vad --max-session 900 &
    $S --pcm $P/ex_600.pcm --out $PRIV/cmp_turn_600.jsonl --commit turn_prediction --max-session 900 &
    $S --pcm $P/ex_600.pcm --out $PRIV/cmp_manual25_600.jsonl --commit manual --manual-every 25 --max-session 900 &
    wait
    $S --pcm $P/ex_2400.pcm --out $PRIV/cmp_vad_2400.jsonl --commit vad --max-session 900 &
    $S --pcm $P/ex_2400.pcm --out $PRIV/cmp_turn_names_2400.jsonl --commit turn_prediction --infer-names --max-session 900 &
    wait ;;
  long)    $S --pcm $P/full.pcm --out $PRIV/long_full.jsonl --commit ${2:-turn_prediction} --max-session 14400 ;;
  reconnect) $S --pcm $P/recon_1200.pcm --out $PRIV/reconnect.jsonl --commit ${2:-turn_prediction} --reconnect-at 300 --max-session 1800 ;;
  keyterms) shift; KT=(); for k in "$@"; do KT+=(--keyterm "$k"); done
    $S --pcm $P/ex_4200.pcm --out $PRIV/kt_off.jsonl --commit turn_prediction --max-session 900 &
    $S --pcm $P/ex_4200.pcm --out $PRIV/kt_on.jsonl --commit turn_prediction --max-session 900 $KT &
    wait ;;
  fixture) node $REPO/spike/tts-fixture.mjs $PRIV/fixture-work
    ffmpeg -nostdin -loglevel error -y -i $REPO/fixtures/elevenlabs/scripted.wav -f s16le -ac 1 -ar 16000 $PRIV/fixture-work/scripted.pcm
    rm -f $REPO/fixtures/elevenlabs/scripted.jsonl
    $S --pcm $PRIV/fixture-work/scripted.pcm --out $REPO/fixtures/elevenlabs/scripted.jsonl --commit ${2:-turn_prediction} --max-session 900 \
      --keyterm "Anna Lindqvist" --keyterm "Erik Johansson" --keyterm "Maja Berg" --keyterm "Tom Fletcher" --keyterm "Kårhuset" ;;
  *) echo "usage: run-all.sh smoke|compare|long [strategy]|reconnect [strategy]|keyterms <names...>|fixture [strategy]"; exit 2 ;;
esac
