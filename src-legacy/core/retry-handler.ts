import pRetry, { AbortError } from 'p-retry';
import { RetryPolicy } from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ component: 'retry-handler' });

export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  context?: { taskId?: string; agentId?: string }
): Promise<T> {
  return pRetry(
    async (attemptNumber) => {
      logger.debug({ ...context, attempt: attemptNumber }, 'Executing with retry');

      try {
        return await fn();
      } catch (error) {
        // Check if error is retryable
        if (policy.retryableErrors && error instanceof Error) {
          const isRetryable = policy.retryableErrors.some((pattern) =>
            error.message.includes(pattern)
          );

          if (!isRetryable) {
            logger.warn(
              { ...context, error, attempt: attemptNumber },
              'Non-retryable error, aborting'
            );
            throw new AbortError(error);
          }
        }

        logger.warn({ ...context, error, attempt: attemptNumber }, 'Retryable error occurred');
        throw error;
      }
    },
    {
      retries: policy.maxAttempts - 1,
      factor: policy.backoffMultiplier,
      minTimeout: policy.backoffMs,
      maxTimeout: policy.maxBackoffMs,
      onFailedAttempt: (error) => {
        logger.warn(
          {
            ...context,
            attempt: error.attemptNumber,
            retriesLeft: error.retriesLeft,
          },
          'Retry attempt failed'
        );
      },
    }
  );
}
