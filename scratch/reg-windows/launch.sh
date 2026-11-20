#!/bin/zsh
app=$1; data=$2; port=$3
open -g -n --env ARDIA_BACKGROUND=1 --env ARDIA_DATA_DIR=$data --env ARDIA_REMOTE_DEBUGGING_PORT=$port $app
for i in {1..60}; do pid=$(lsof -nP -iTCP:$port -sTCP:LISTEN -t 2>/dev/null | head -1); [[ -n $pid ]] && break; sleep 0.5; done
echo $pid > $data/pid
echo "pid=$pid"; ps -o command= -p $pid
