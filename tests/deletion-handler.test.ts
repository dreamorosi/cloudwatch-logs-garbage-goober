import { FullBatchFailureError } from '@aws-lambda-powertools/batch';
import {
  CloudWatchLogsClient,
  DeleteLogGroupCommand,
  DescribeLogGroupsCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-cloudwatch-logs';
import type { SQSEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../src/deletion-handler.js';
import { context, getTestEvent, wrapInSQSEvent } from './helpers.js';

vi.hoisted(() => {
  process.env.POWERTOOLS_DEV = 'true';
  process.env.AWS_REGION = 'eu-west-1';
});

describe('deletion-handler', () => {
  const cwClient = mockClient(CloudWatchLogsClient);

  const logGroupName = '/aws/lambda/Logger-20-x86-test-group';

  // Message without `creationTime`, i.e. scheduled before the recreation guard
  // was introduced
  const event = getTestEvent<SQSEvent>({
    eventsPath: '.',
    filename: 'sqs-event',
  });

  /**
   * Make `DescribeLogGroups` return a live log group with the given creation time
   */
  const mockLiveLogGroup = (creationTime?: number) => {
    cwClient.on(DescribeLogGroupsCommand).resolves({
      logGroups: [{ logGroupName, creationTime }],
    });
  };

  afterEach(() => {
    cwClient.reset();
    vi.clearAllMocks();
  });

  it('successfully deletes a log group', async () => {
    // Prepare
    mockLiveLogGroup(1_700_000_000_000);
    cwClient.on(DeleteLogGroupCommand).resolves({});

    // Act
    const result = await handler(event, context, () => {});

    // Assess
    expect(result).toEqual({ batchItemFailures: [] });
    expect(cwClient).toReceiveCommandWith(DescribeLogGroupsCommand, {
      logGroupNamePrefix: logGroupName,
    });
    expect(cwClient).toReceiveCommandWith(DeleteLogGroupCommand, {
      logGroupName,
    });
  });

  it('deletes the log group when the scheduled creation time still matches', async () => {
    // Prepare
    mockLiveLogGroup(1_700_000_000_000);
    cwClient.on(DeleteLogGroupCommand).resolves({});

    // Act
    const result = await handler(
      wrapInSQSEvent({
        logGroupName,
        awsRegion: 'eu-west-1',
        creationTime: 1_700_000_000_000,
      }),
      context,
      () => {}
    );

    // Assess
    expect(result).toEqual({ batchItemFailures: [] });
    expect(cwClient).toReceiveCommandWith(DeleteLogGroupCommand, {
      logGroupName,
    });
  });

  it('skips deletion when the log group was recreated after being scheduled', async () => {
    // Prepare - the live log group is newer than the one the schedule was
    // created for, i.e. it was deleted and recreated with the same name
    mockLiveLogGroup(1_700_000_500_000);
    cwClient.on(DeleteLogGroupCommand).resolves({});

    // Act
    const result = await handler(
      wrapInSQSEvent({
        logGroupName,
        awsRegion: 'eu-west-1',
        creationTime: 1_700_000_000_000,
      }),
      context,
      () => {}
    );

    // Assess - the message succeeds, so it is not retried nor sent to the DLQ
    expect(result).toEqual({ batchItemFailures: [] });
    expect(cwClient.commandCalls(DeleteLogGroupCommand)).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Log group was recreated after the deletion was scheduled'
      )
    );
  });

  it('deletes the log group when the live one has no creation time', async () => {
    // Prepare
    mockLiveLogGroup(undefined);
    cwClient.on(DeleteLogGroupCommand).resolves({});

    // Act
    const result = await handler(
      wrapInSQSEvent({
        logGroupName,
        awsRegion: 'eu-west-1',
        creationTime: 1_700_000_000_000,
      }),
      context,
      () => {}
    );

    // Assess
    expect(result).toEqual({ batchItemFailures: [] });
    expect(cwClient).toReceiveCommandWith(DeleteLogGroupCommand, {
      logGroupName,
    });
  });

  it('treats a log group that no longer exists as success (idempotent)', async () => {
    // Prepare
    cwClient.on(DescribeLogGroupsCommand).resolves({});

    // Act
    const result = await handler(event, context, () => {});

    // Assess
    expect(result).toEqual({ batchItemFailures: [] });
    expect(cwClient.commandCalls(DeleteLogGroupCommand)).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Log group already deleted')
    );
  });

  it('treats the absence of an exact name match as success (idempotent)', async () => {
    // Prepare - only log groups sharing the prefix are left
    cwClient.on(DescribeLogGroupsCommand).resolves({
      logGroups: [
        { logGroupName: `${logGroupName}-extra`, creationTime: 1_000 },
      ],
    });

    // Act
    const result = await handler(event, context, () => {});

    // Assess
    expect(result).toEqual({ batchItemFailures: [] });
    expect(cwClient.commandCalls(DeleteLogGroupCommand)).toHaveLength(0);
  });

  it('treats ResourceNotFoundException as success (idempotent)', async () => {
    // Prepare - the log group is deleted between the lookup and the deletion
    mockLiveLogGroup(1_700_000_000_000);
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
    mockLiveLogGroup(1_700_000_000_000);
    cwClient.on(DeleteLogGroupCommand).rejects(new Error('Access denied'));

    // Act & Assess
    await expect(handler(event, context, () => {})).rejects.toThrow(
      FullBatchFailureError
    );
  });

  it('throws FullBatchFailureError when the log group cannot be described', async () => {
    // Prepare
    cwClient
      .on(DescribeLogGroupsCommand)
      .rejects(new Error('Rate exceeded'))
      .on(DeleteLogGroupCommand)
      .resolves({});

    // Act & Assess
    await expect(handler(event, context, () => {})).rejects.toThrow(
      FullBatchFailureError
    );
    expect(cwClient.commandCalls(DeleteLogGroupCommand)).toHaveLength(0);
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
      .on(DescribeLogGroupsCommand, {
        logGroupNamePrefix: '/aws/lambda/test-group-1',
      })
      .resolves({
        logGroups: [
          { logGroupName: '/aws/lambda/test-group-1', creationTime: 1_000 },
        ],
      })
      .on(DescribeLogGroupsCommand, {
        logGroupNamePrefix: '/aws/lambda/test-group-2',
      })
      .resolves({
        logGroups: [
          { logGroupName: '/aws/lambda/test-group-2', creationTime: 1_000 },
        ],
      })
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
