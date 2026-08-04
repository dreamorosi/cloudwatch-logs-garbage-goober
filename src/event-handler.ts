import { createHash } from 'node:crypto';
import {
  BatchProcessor,
  EventType,
  processPartialResponse,
} from '@aws-lambda-powertools/batch';
import { parser } from '@aws-lambda-powertools/batch/parser';
import type { ParsedRecord } from '@aws-lambda-powertools/batch/types';
import { addUserAgentMiddleware } from '@aws-lambda-powertools/commons';
import {
  getNumberFromEnv,
  getStringFromEnv,
} from '@aws-lambda-powertools/commons/utils/env';
import { parse } from '@aws-lambda-powertools/parser';
import { EventBridgeEnvelope } from '@aws-lambda-powertools/parser/envelopes';
import type { EventBridgeEvent } from '@aws-lambda-powertools/parser/types';
import {
  ActionAfterCompletion,
  ConflictException,
  CreateScheduleCommand,
  FlexibleTimeWindowMode,
  SchedulerClient,
} from '@aws-sdk/client-scheduler';
import type { Context, SQSHandler, SQSRecord } from 'aws-lambda';
import { Temporal } from 'temporal-polyfill';
import { z } from 'zod';
import { findLogGroupByName } from './cloudwatch.js';
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
const fallbackRetentionDays = getNumberFromEnv({
  key: 'FALLBACK_RETENTION_DAYS',
});

/**
 * Build the name of the schedule that deletes the given log group
 *
 * The name is derived from the log group name and the creation event time so
 * that reprocessing the same message always produces the same name, which
 * makes schedule creation idempotent across SQS redeliveries. The event time
 * is part of the digest so that a log group that is deleted and recreated with
 * the same name still gets a schedule of its own.
 *
 * The result is at most 44 characters long and only contains characters
 * allowed by EventBridge Scheduler, which caps names at 64 characters.
 *
 * @param param - options object
 * @param param.logGroupName - The name of the log group
 * @param param.eventTime - The time the log group was created
 */
const getScheduleName = ({
  logGroupName,
  eventTime,
}: {
  logGroupName: string;
  eventTime: string;
}) => {
  // Extract a short name from the log group for the schedule name
  const shortNameStart = logGroupName.lastIndexOf('/') + 1;
  const shortName = logGroupName
    .substring(shortNameStart, shortNameStart + 18)
    .replace(/[^\w.-]/g, '-');
  const digest = createHash('sha256')
    .update(`${logGroupName}|${eventTime}`)
    .digest('hex')
    .substring(0, 10);

  return `DeleteLogGroup-${shortName}-${digest}`;
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
 * @param param.creationTime - Creation time (epoch ms) of the log group this
 * schedule is created for, used by the deletion handler to make sure it does
 * not delete a newer log group that reuses the same name
 */
const createDeleteSchedule = async ({
  retentionInDays,
  eventTime,
  logGroupName,
  region,
  creationTime,
}: {
  retentionInDays: number;
  eventTime: string;
  logGroupName: string;
  region: string;
  creationTime?: number;
}) => {
  // EventBridge Scheduler rejects `at()` expressions with fractional seconds,
  // so the deletion date is truncated to whole seconds in case the event time
  // carries sub-second precision
  const deletionDate = Temporal.Instant.from(eventTime)
    .toZonedDateTimeISO('UTC')
    .add({ days: retentionInDays + deletionDelayDays })
    .toInstant()
    .round({ smallestUnit: 'second', roundingMode: 'floor' });

  const scheduleName = getScheduleName({ logGroupName, eventTime });

  try {
    await schedulerClient.send(
      new CreateScheduleCommand({
        ScheduleExpression: `at(${deletionDate.toString().replace('Z', '')})`,
        FlexibleTimeWindow: {
          Mode: FlexibleTimeWindowMode.FLEXIBLE,
          MaximumWindowInMinutes: 5,
        },
        Name: scheduleName,
        Target: {
          RoleArn: schedulerRoleArn,
          Arn: deletionQueueArn,
          Input: JSON.stringify({
            logGroupName: logGroupName,
            awsRegion: region,
            creationTime: creationTime,
          }),
        },
        ActionAfterCompletion: ActionAfterCompletion.DELETE,
      })
    );
  } catch (error) {
    if (error instanceof ConflictException) {
      // The schedule was already created by an earlier attempt at processing
      // this same event, so there is nothing left to do
      logger.info('Deletion schedule already exists, skipping creation', {
        scheduleName,
      });
      return;
    }
    throw error;
  }
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

  const logGroup = await findLogGroupByName({
    region: awsRegion,
    logGroupName,
  });
  if (!logGroup) {
    logger.warn('Log group not found, skipping schedule creation', {
      logGroupName,
      awsRegion,
    });
    return;
  }

  const { retentionInDays, creationTime } = logGroup;
  if (retentionInDays === undefined) {
    // Either the log group is set to never expire, or `PutRetentionPolicy` has
    // not been called yet (the event processing queue delays messages to give
    // it time to land). Rather than silently treating this as a retention of
    // zero days, which would delete the log group almost immediately, we fall
    // back to a configured retention period.
    logger.warn(
      'Log group has no retention policy, falling back to the configured retention period',
      { fallbackRetentionDays }
    );
  }

  await createDeleteSchedule({
    retentionInDays: retentionInDays ?? fallbackRetentionDays,
    eventTime,
    logGroupName,
    region: awsRegion,
    creationTime,
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
