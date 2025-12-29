import {
  BatchProcessor,
  EventType,
  processPartialResponse,
} from '@aws-lambda-powertools/batch';
import { parser } from '@aws-lambda-powertools/batch/parser';
import type { ParsedRecord } from '@aws-lambda-powertools/batch/types';
import {
  DeleteLogGroupCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-cloudwatch-logs';
import type { SQSHandler, SQSRecord } from 'aws-lambda';
import { z } from 'zod';
import { getRegionalCwClient } from './cloudwatch.js';
import { logger } from './logger.js';

const DeletionMessageSchema = z.object({
  logGroupName: z.string(),
  awsRegion: z.string(),
});

const processor = new BatchProcessor(EventType.SQS, {
  parser,
  innerSchema: DeletionMessageSchema,
  transformer: 'json',
  logger,
});

/**
 * Process a single SQS record and delete the corresponding log group
 */
const recordHandler = async ({
  body: { logGroupName, awsRegion },
}: ParsedRecord<SQSRecord, z.infer<typeof DeletionMessageSchema>>) => {
  logger.info('Deleting log group', { logGroupName, awsRegion });
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
