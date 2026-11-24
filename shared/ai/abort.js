/** True when `signal` (a request signal combined with a deadline) was aborted by the deadline, not the client. */
export function isDeadlineAbort(signal, deadlineSignal) {
    return !!signal?.aborted && !!deadlineSignal?.aborted && signal.reason === deadlineSignal.reason;
}
