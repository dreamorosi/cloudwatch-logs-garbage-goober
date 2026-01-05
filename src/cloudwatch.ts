import { addUserAgentMiddleware } from '@aws-lambda-powertools/commons';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { logger } from './logger.js';

const cwClientMap = new Map<string, CloudWatchLogsClient>();

/**
 * Get or create a CloudWatchLogsClient for the given AWS region
 */
const getRegionalCwClient = (region: string): CloudWatchLogsClient => {
  let cwClient = cwClientMap.get(region);
  if (!cwClient) {
    logger.debug('Creating new CloudWatchLogsClient for region', { region });
    cwClient = new CloudWatchLogsClient({
      region,
      retryMode: 'adaptive',
      maxAttempts: 5,
    });
    addUserAgentMiddleware(cwClient, 'NO-OP');
    cwClientMap.set(region, cwClient);
  }

  return cwClient;
};

export { getRegionalCwClient };
