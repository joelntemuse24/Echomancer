#!/bin/bash

cleanup() {
    echo "Cleaning up..."
    pkill -P $$
    exit 0
}

trap cleanup SIGINT SIGTERM

source /app/.venv/bin/activate

# Start fish-speech API server in background
python3 /app/tools/api_server.py \
    --llama-checkpoint-path /app/checkpoints/s2-pro \
    --decoder-checkpoint-path /app/checkpoints/s2-pro/codec.pth \
    --device cuda \
    2>&1 | tee /tmp/fish.server.log &

FISH_PID=$!

check_server_is_running() {
    echo "Waiting for fish-speech server..."
    if grep -q "Uvicorn running" /tmp/fish.server.log 2>/dev/null; then
        return 0
    else
        return 1
    fi
}

while ! check_server_is_running; do
    # Verifica se o servidor morreu durante o startup
    if ! kill -0 $FISH_PID 2>/dev/null; then
        echo "Fish server failed to start. Check /tmp/fish.server.log"
        cat /tmp/fish.server.log
        exit 1
    fi
    sleep 3
done

echo "Fish-speech server is up. Starting RunPod handler..."
python3 -u /app/src/handler.py &
HANDLER_PID=$!

# Se qualquer um dos dois morrer, mata tudo
wait -n $FISH_PID $HANDLER_PID
echo "A process exited unexpectedly, shutting down..."
kill $FISH_PID $HANDLER_PID 2>/dev/null
exit 1
