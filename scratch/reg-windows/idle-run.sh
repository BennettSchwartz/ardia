#!/bin/zsh
R=~/ardia-scratch/reg-windows
T=$R/tools
start=$(date +%s)
touch $R/data/idle-start.marker
$T/launch.sh $R/dl/n9/Ardia.app $R/data/n9c 9471
$T/launch.sh $R/dl/v46/Ardia.app $R/data/v46c 9472
N=$(cat $R/data/n9c/pid); V=$(cat $R/data/v46c/pid)
echo "n9=$N v46=$V"
sleep 20
for P in $N $V; do $T/key $P 19 t; done; sleep 12
for P in $N $V; do $T/key $P 20 t; done; sleep 12
for P in $N $V; do $T/key $P 18 t; done; sleep 5
for P in $N $V; do $T/key $P 43 c; done; sleep 5
for v in n9c v46c; do echo "== $v"; $T/winlist $(cat $R/data/$v/pid); done
check() { for v in n9c v46c; do P=$(cat $R/data/$v/pid); if kill -0 $P 2>/dev/null; then echo "$(date +%T) $v alive"; else echo "$(date +%T) $v GONE"; fi; done; }
for i in {1..8}; do sleep 60; check; done
for P in $N $V; do kill -0 $P 2>/dev/null && $T/key $P 43 c; done
for P in $N $V; do kill -0 $P 2>/dev/null && $T/key $P 19 t; done
sleep 10
for P in $N $V; do kill -0 $P 2>/dev/null && $T/key $P 18 t; done
for i in {1..3}; do sleep 60; check; done
echo "reports since start:"; find ~/Library/Logs/DiagnosticReports -newer $R/data/idle-start.marker -name 'Ardia*' 2>/dev/null
ls $R/data/n9c/crashes $R/data/v46c/crashes 2>/dev/null
grep -iE "RCTFatal|fatal" $R/data/n9c/*.log 2>/dev/null | head
