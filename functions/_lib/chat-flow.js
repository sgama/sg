import { SAFE_NO_CONTEXT_MESSAGE, shouldAbstainForMissingContext } from './validation.js';
import { createSseMessageStream } from './chat-stream.js';
import { LogService } from './log.js';

/**
 * One chat turn: retrieve context, announce evidence, then either abstain or
 * generate. Returns the answer stream, wrapped for logging when a log store is
 * bound. Events leave through `emit`, so the route owns the transport.
 */
export async function answerChat({ aiService, env, executionCtx, query, history, emit }) {
    const { contextText, evidence } = await aiService.retrieve(query, history, (stage) => emit({ progress: stage }));
    await emit({ evidence });

    let stream;
    if (shouldAbstainForMissingContext(contextText)) {
        stream = createSseMessageStream(SAFE_NO_CONTEXT_MESSAGE, aiService.responseMetrics({ abstained: true }));
    } else {
        await emit({ progress: 'generation' });
        stream = await aiService.generateStream(query, contextText, history);
    }
    return env.CHAT_LOGS ? LogService.save(env, query, stream, executionCtx) : stream;
}
