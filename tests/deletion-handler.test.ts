import { FullBatchFailureError } from '@aws-lambda-powertools/batch';
import {
  CloudWatchLogsClient,
  DeleteLogGroupCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-cloudwatch-logs';
import type { SQSEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../src/deletion-handler.js';
import { context, getTestEvent } from './helpers.js';

vi.hoisted(() => {
  process.env.POWERTOOLS_DEV = 'true';
  process.env.AWS_REGION = 'eu-west-1';
});

describe('deletion-handler', () => {
  const cwClient = mockClient(CloudWatchLogsClient);

  const event = getTestEvent<SQSEvent>({
    eventsPath: '.',
    filename: 'sqs-event',
  });

  afterEach(() => {
    cwClient.reset();
  });

  it('successfully deletes a log group', async () => {
    // Prepare
    cwClient.on(DeleteLogGroupCommand).resolves({});

    // Act
    const result = await handler(event, context, () => {});

    // Assess
    expect(result).toEqual({ batchItemFailures: [] });
    expect(cwClient).toReceiveCommandWith(DeleteLogGroupCommand, {
      logGroupName: '/aws/lambda/Logger-20-x86-test-group',
    });
  });

  it('treats ResourceNotFoundException as success (idempotent)', async () => {
    // Prepare
    cwClient.on(DeleteLogGroupCommand).rejects(
      new ResourceNotFoundException({
        message: 'The specified log group does not exist',
        $metadata: {},
      })
    );

    // Act
    const result = await handler(event, context, () => {});

    // Assess - should succeed, log group already deleted
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('throws FullBatchFailureError for other errors', async () => {
    // Prepare
    cwClient.on(DeleteLogGroupCommand).rejects(new Error('Access denied'));

    // Act & Assess
    await expect(handler(event, context, () => {})).rejects.toThrow(
      FullBatchFailureError
    );
  });

  it('handles multiple records with partial failures', async () => {
    // Prepare
    const multiRecordEvent: SQSEvent = {
      Records: [
        {
          messageId: 'success-1',
          receiptHandle: 'handle-1',
          body: JSON.stringify({
            logGroupName: '/aws/lambda/test-group-1',
            awsRegion: 'eu-west-1',
          }),
          attributes: {
            ApproximateReceiveCount: '1',
            SentTimestamp: '1545082649636',
            SenderId: 'AIDACKCEVSQ6C2EXAMPLE',
            ApproximateFirstReceiveTimestamp: '1545082649649',
          },
          messageAttributes: {},
          md5OfBody: 'hash1',
          eventSource: 'aws:sqs',
          eventSourceARN: 'arn:aws:sqs:eu-west-1:123456789012:deletion-queue',
          awsRegion: 'eu-west-1',
        },
        {
          messageId: 'failure-1',
          receiptHandle: 'handle-2',
          body: JSON.stringify({
            logGroupName: '/aws/lambda/test-group-2',
            awsRegion: 'eu-west-1',
          }),
          attributes: {
            ApproximateReceiveCount: '1',
            SentTimestamp: '1545082649636',
            SenderId: 'AIDACKCEVSQ6C2EXAMPLE',
            ApproximateFirstReceiveTimestamp: '1545082649649',
          },
          messageAttributes: {},
          md5OfBody: 'hash2',
          eventSource: 'aws:sqs',
          eventSourceARN: 'arn:aws:sqs:eu-west-1:123456789012:deletion-queue',
          awsRegion: 'eu-west-1',
        },
      ],
    };

    cwClient
      .on(DeleteLogGroupCommand, { logGroupName: '/aws/lambda/test-group-1' })
      .resolves({})
      .on(DeleteLogGroupCommand, { logGroupName: '/aws/lambda/test-group-2' })
      .rejects(new Error('Delete failed'));

    // Act
    const result = await handler(multiRecordEvent, context, () => {});

    // Assess
    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: 'failure-1' }],
    });
  });

  it('throws FullBatchFailureError for invalid message body', async () => {
    // Prepare
    const invalidEvent: SQSEvent = {
      Records: [
        {
          messageId: 'invalid-1',
          receiptHandle: 'handle-1',
          body: 'invalid json',
          attributes: {
            ApproximateReceiveCount: '1',
            SentTimestamp: '1545082649636',
            SenderId: 'AIDACKCEVSQ6C2EXAMPLE',
            ApproximateFirstReceiveTimestamp: '1545082649649',
          },
          messageAttributes: {},
          md5OfBody: 'hash1',
          eventSource: 'aws:sqs',
          eventSourceARN: 'arn:aws:sqs:eu-west-1:123456789012:deletion-queue',
          awsRegion: 'eu-west-1',
        },
      ],
    };

    // Act & Assess
    await expect(handler(invalidEvent, context, () => {})).rejects.toThrow(
      FullBatchFailureError
    );
  });

  it('throws FullBatchFailureError for messages with missing required fields', async () => {
    // Prepare
    const missingFieldsEvent: SQSEvent = {
      Records: [
        {
          messageId: 'missing-fields-1',
          receiptHandle: 'handle-1',
          body: JSON.stringify({ logGroupName: '/aws/lambda/test-group' }),
          attributes: {
            ApproximateReceiveCount: '1',
            SentTimestamp: '1545082649636',
            SenderId: 'AIDACKCEVSQ6C2EXAMPLE',
            ApproximateFirstReceiveTimestamp: '1545082649649',
          },
          messageAttributes: {},
          md5OfBody: 'hash1',
          eventSource: 'aws:sqs',
          eventSourceARN: 'arn:aws:sqs:eu-west-1:123456789012:deletion-queue',
          awsRegion: 'eu-west-1',
        },
      ],
    };

    // Act & Assess
    await expect(
      handler(missingFieldsEvent, context, () => {})
    ).rejects.toThrow(FullBatchFailureError);
  });
});
