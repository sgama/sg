#!/usr/bin/env bash
set -euo pipefail

volume_label="sg.ai-local.model-cache"
if [[ "${1:-}" == "clean" ]]; then
    owner=$("$DOCKER" volume inspect --format '{{index .Labels "sg.ai-local.model-cache"}}' "$AI_LOCAL_VOLUME")
    if [[ "$owner" != true ]]; then
        echo "Refusing to delete unowned volume: $AI_LOCAL_VOLUME" >&2
        exit 1
    fi
    "$DOCKER" volume rm "$AI_LOCAL_VOLUME"
    exit
fi

project="sg-ai-local-$$"
compose() {
    "$DOCKER" compose --file docker-compose.yml --project-name "$project" "$@"
}
cleanup() {
    status=$?
    trap - EXIT
    if ! compose down --remove-orphans >/dev/null; then
        echo "Failed to clean up local AI Compose project: $project" >&2
        status=1
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"$DOCKER" volume create --label "$volume_label=true" "$AI_LOCAL_VOLUME" >/dev/null
owner=$("$DOCKER" volume inspect --format '{{index .Labels "sg.ai-local.model-cache"}}' "$AI_LOCAL_VOLUME")
if [[ "$owner" != true ]]; then
    echo "Refusing to use unowned volume: $AI_LOCAL_VOLUME (set AI_LOCAL_VOLUME to a new name)" >&2
    exit 1
fi
echo "Temporary local AI Compose project: $project"
start_service() {
    service=$1
    service_port=$2
    health=$3
    compose up --detach "$service"
    container=$(compose ps --quiet "$service")
    port=$(compose port "$service" "$service_port")
    export AI_LOCAL_URL="http://$port"
    export AI_LOCAL_IMAGE_ID
    AI_LOCAL_IMAGE_ID=$("$DOCKER" inspect --format '{{.Image}}' "$container")
    for ((attempt=0; attempt<300; attempt++)); do
        if curl --fail --silent --max-time 2 "$AI_LOCAL_URL/$health" >/dev/null; then
            return
        fi
        sleep 1
    done
    compose logs "$service" >&2
    echo "$service did not become ready on $AI_LOCAL_URL" >&2
    exit 1
}
evaluate() {
    "$NODE" scripts/ai-local-eval.mjs --url "$AI_LOCAL_URL" \
        --generation "${AI_LOCAL_GENERATION:-local}" --cloud-model "${AI_LOCAL_CLOUD_MODEL:-glm}" \
        --model "$AI_LOCAL_MODEL" --embedding-model "$AI_LOCAL_EMBED_MODEL" \
        --context-tokens "${AI_LOCAL_CONTEXT:-4096}" \
        --dimensions "$AI_LOCAL_DIMENSIONS" --fixture "$AI_FIXTURE" \
        --repeats "$AI_REPEATS" --timeout-ms "$AI_LOCAL_TIMEOUT_MS" \
        --min-hit-rate "$AI_MIN_HIT_RATE" --min-answer-rate "$AI_MIN_ANSWER_RATE" "$@"
}

if [[ "${AI_LOCAL_GENERATION:-local}" == cloudflare ]]; then
    : "${CLOUDFLARE_ACCOUNT_ID:?Missing CLOUDFLARE_ACCOUNT_ID}"
    : "${CLOUDFLARE_API_TOKEN:?Missing CLOUDFLARE_API_TOKEN}"
fi
start_service embeddings 80 health
evaluate --retrieval-only --output "$AI_LOCAL_REPORT.retrieval.json"
compose stop embeddings
if [[ "${AI_LOCAL_GENERATION:-local}" == local ]]; then
    start_service ollama 11434 api/version
    compose exec --no-TTY ollama ollama pull "$AI_LOCAL_MODEL"
fi
evaluate --retrieval-report "$AI_LOCAL_REPORT.retrieval.json" --output "$AI_LOCAL_REPORT"
