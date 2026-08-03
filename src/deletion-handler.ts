import {
  BatchProcessor,
  EventType,
  processPartialResponse,
} from '@aws-lambda-powertools/batch';
import { parser } from '@aws-lambda-powertools/batch/parser';
import type { ParsedRecord } from '@aws-lambda-powertools/batch/types';
import {
  DeleteLogGroupCommand,
  DescribeLogGroupsCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-cloudwatch-logs';
import type { SQSHandler, SQSRecord } from 'aws-lambda';
import { z } from 'zod';
import { getRegionalCwClient } from './cloudwatch.js';
import { logger } from './logger.js';

const DeletionMessageSchema = z.object({
  logGroupName: z.string(),
  awsRegion: z.string(),
  /**
   * Creation time (epoch ms) of the log group incarnation this deletion was
   * scheduled for. Optional for backwards compatibility with schedules that
   * were created before this field was introduced.
   */
  creationTime: z.number().optional(),
});

const processor = new BatchProcessor(EventType.SQS, {
  parser,
  innerSchema: DeletionMessageSchema,
  transformer: 'json',
  logger,
});

/**
 * Look up the log group with the exact given name, or `undefined` if it does
 * not exist anymore
 *
 * @param param - options object
 * @param param.logGroupName - Name of the log group to look up
 * @param param.awsRegion - AWS region where the log group is located
 */
const findLogGroup = async ({
  logGroupName,
  awsRegion,
}: {
  logGroupName: string;
  awsRegion: string;
}) => {
  const cwClient = getRegionalCwClient(awsRegion);
  const response = await cwClient.send(
    new DescribeLogGroupsCommand({
      logGroupNamePrefix: logGroupName,
    })
  );

  return response.logGroups?.find((lg) => lg.logGroupName === logGroupName);
};

/**
 * Process a single SQS record and delete the corresponding log group
 */
const recordHandler = async ({
  body: { logGroupName, awsRegion, creationTime },
}: ParsedRecord<SQSRecord, z.infer<typeof DeletionMessageSchema>>) => {
  logger.info('Processing log group deletion', { logGroupName, awsRegion });

  const logGroup = await findLogGroup({ logGroupName, awsRegion });
  if (!logGroup) {
    logger.warn('Log group already deleted', { logGroupName, awsRegion });
    return;
  }

  if (
    creationTime !== undefined &&
    logGroup.creationTime !== undefined &&
    logGroup.creationTime > creationTime
  ) {
    // The log group was deleted and recreated with the same name after this
    // deletion was scheduled, so the schedule refers to an incarnation that is
    // already gone. Deleting now would take out a brand new log group and its
    // fresh logs, so we skip it and let the newer incarnation's own schedule
    // take care of it.
    logger.warn(
      'Log group was recreated after the deletion was scheduled, skipping deletion',
      {
        logGroupName,
        awsRegion,
        scheduledCreationTime: creationTime,
        currentCreationTime: logGroup.creationTime,
      }
    );
    return;
  }

  const cwClient = getRegionalCwClient(awsRegion);
  try {
    await cwClient.send(
      new DeleteLogGroupCommand({
        logGroupName,
      })
    );
    logger.info('Successfully deleted log group', { logGroupName, awsRegion });
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      logger.warn('Log group already deleted', { logGroupName, awsRegion });
      return;
    }
    throw error;
  }
};

export const handler: SQSHandler = async (event, context) => {
  logger.addContext(context);
  logger.logEventIfEnabled(event);

  return processPartialResponse(event, recordHandler, processor, {
    context,
  });
};
