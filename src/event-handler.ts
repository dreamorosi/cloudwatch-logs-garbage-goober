import { randomUUID } from 'node:crypto';
import { addUserAgentMiddleware } from '@aws-lambda-powertools/commons';
import {
  getNumberFromEnv,
  getStringFromEnv,
} from '@aws-lambda-powertools/commons/utils/env';
import {
  BatchProcessor,
  EventType,
  processPartialResponse,
} from '@aws-lambda-powertools/batch';
import { parser } from '@aws-lambda-powertools/batch/parser';
import type { ParsedRecord } from '@aws-lambda-powertools/batch/types';
import { parse } from '@aws-lambda-powertools/parser';
import { EventBridgeEnvelope } from '@aws-lambda-powertools/parser/envelopes';
import type { EventBridgeEvent } from '@aws-lambda-powertools/parser/types';
import { DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import {
  ActionAfterCompletion,
  CreateScheduleCommand,
  FlexibleTimeWindowMode,
  SchedulerClient,
} from '@aws-sdk/client-scheduler';
import type { Context, SQSHandler, SQSRecord } from 'aws-lambda';
import { Temporal } from 'temporal-polyfill';
import { z } from 'zod';
import { getRegionalCwClient } from './cloudwatch.js';
import { logger } from './logger.js';

const schedulerClient = new SchedulerClient({
  retryMode: 'adaptive',
  maxAttempts: 5,
});
addUserAgentMiddleware(schedulerClient, 'NO-OP');

const EventBridgeEventSchema = z.object({
  detail: z.object({
    eventTime: z.string(),
    awsRegion: z.string(),
    requestParameters: z.object({
      logGroupName: z.string(),
    }),
  }),
});

const processor = new BatchProcessor(EventType.SQS, {
  parser,
  innerSchema: EventBridgeEventSchema,
  transformer: 'json',
  logger,
});

const deletionQueueArn = getStringFromEnv({ key: 'DELETION_QUEUE_ARN' });
const schedulerRoleArn = getStringFromEnv({ key: 'SCHEDULER_ROLE_ARN' });
const deletionDelayDays = getNumberFromEnv({ key: 'DELETION_DELAY_DAYS' });

/**
 * Fetch log group info for the given log group name
 *
 * @param param - options object
 * @param param.region - AWS region where the log group is located
 * @param param.logGroupName - Name of the log group to fetch info for
 */
const fetchLogGroupInfo = async ({
  region,
  logGroupName,
}: {
  region: string;
  logGroupName: string;
}) => {
  const cwClient = getRegionalCwClient(region);

  const response = await cwClient.send(
    new DescribeLogGroupsCommand({
      logGroupNamePrefix: logGroupName,
    })
  );
  logger.debug('Log group info', { response: response.logGroups || [] });

  const logGroup = response.logGroups?.find(
    (lg) => lg.logGroupName === logGroupName
  );
  if (!logGroup) {
    const message = 'Log group not found or does not exist';
    logger.error(message);
    throw new Error(message);
  }

  return logGroup;
};

/**
 * Create an Amazon EventBridge Scheduler schedule to delete the log group
 * after the retention period plus configured delay
 *
 * @param param - options object
 * @param param.eventTime - The time the log group was created
 * @param param.logGroupName - The name of the log group
 * @param param.region - The AWS region where the log group is located
 * @param param.retentionInDays - The number of days to retain logs for
 */
const createDeleteSchedule = async ({
  retentionInDays,
  eventTime,
  logGroupName,
  region,
}: {
  retentionInDays: number;
  eventTime: string;
  logGroupName: string;
  region: string;
}) => {
  const deletionDate = Temporal.Instant.from(eventTime)
    .toZonedDateTimeISO('UTC')
    .add({ days: retentionInDays + deletionDelayDays })
    .toInstant();

  // Extract a short name from the log group for the schedule name
  const shortName =
    logGroupName.split('/').pop()?.substring(0, 18) ?? 'unknown';

  await schedulerClient.send(
    new CreateScheduleCommand({
      ScheduleExpression: `at(${deletionDate.toString().replace('Z', '')})`,
      FlexibleTimeWindow: {
        Mode: FlexibleTimeWindowMode.FLEXIBLE,
        MaximumWindowInMinutes: 5,
      },
      Name: `DeleteLogGroup-${shortName}-${randomUUID().substring(0, 5)}`,
      Target: {
        RoleArn: schedulerRoleArn,
        Arn: deletionQueueArn,
        Input: JSON.stringify({
          logGroupName: logGroupName,
          awsRegion: region,
        }),
      },
      ActionAfterCompletion: ActionAfterCompletion.DELETE,
    })
  );
};

/**
 * Process a single SQS record containing an EventBridge event
 */
const recordHandler = async ({
  body: {
    detail: {
      eventTime,
      awsRegion,
      requestParameters: { logGroupName },
    },
  },
  messageId,
}: ParsedRecord<SQSRecord, z.infer<typeof EventBridgeEventSchema>>) => {
  logger.appendKeys({
    awsRegion,
    logGroupName,
    messageId,
  });

  const logGroup = await fetchLogGroupInfo({
    region: awsRegion,
    logGroupName,
  });
  const { retentionInDays } = logGroup;
  await createDeleteSchedule({
    retentionInDays: retentionInDays ?? 0,
    eventTime,
    logGroupName,
    region: awsRegion,
  });
};

export const handler: SQSHandler = async (event, context) => {
  logger.addContext(context);
  logger.logEventIfEnabled(event);

  return processPartialResponse(event, recordHandler, processor, {
    context,
    throwOnFullBatchFailure: false,
  });
};
