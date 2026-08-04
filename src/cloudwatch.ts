import { addUserAgentMiddleware } from '@aws-lambda-powertools/commons';
import {
  CloudWatchLogsClient,
  type LogGroup,
  paginateDescribeLogGroups,
} from '@aws-sdk/client-cloudwatch-logs';
import { logger } from './logger.js';

/**
 * CloudWatch Logs clients, keyed by region
 *
 * In practice this only ever holds a client for the region the stack is
 * deployed to, since CloudTrail delivers `CreateLogGroup` events to the event
 * bus of the region the call was made in. The region is nonetheless read from
 * the message rather than the execution environment, so that a message whose
 * region does not match is looked up where it claims to be instead of silently
 * against the wrong region.
 */
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

/**
 * Look up the log group with the exact given name, or `undefined` if no log
 * group with that name exists in the region
 *
 * `DescribeLogGroups` can only filter by name prefix and returns at most 50
 * log groups per page, so the exact match can sit on any page when many log
 * groups share the prefix. We follow pagination until the match is found or
 * the results are exhausted.
 *
 * @param param - options object
 * @param param.region - AWS region where the log group is located
 * @param param.logGroupName - Name of the log group to look up
 */
const findLogGroupByName = async ({
  region,
  logGroupName,
}: {
  region: string;
  logGroupName: string;
}): Promise<LogGroup | undefined> => {
  const client = getRegionalCwClient(region);

  for await (const page of paginateDescribeLogGroups(
    { client },
    { logGroupNamePrefix: logGroupName }
  )) {
    logger.debug('Log group lookup page', { logGroups: page.logGroups ?? [] });

    const logGroup = page.logGroups?.find(
      (lg) => lg.logGroupName === logGroupName
    );
    if (logGroup) {
      return logGroup;
    }
  }

  return undefined;
};

export { getRegionalCwClient, findLogGroupByName };
