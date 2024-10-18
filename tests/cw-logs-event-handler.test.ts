import { describe, afterEach, expect, it, vi } from 'vitest';
import { type EventDetail, handler } from '../src/cw-logs-event-handler.js';
import { context, getTestEvent } from './helpers.js';
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  SchedulerClient,
  CreateScheduleCommand,
} from '@aws-sdk/client-scheduler';
import { mockClient } from 'aws-sdk-client-mock';

vi.hoisted(() => {
  process.env.POWERTOOLS_DEV = 'true';
  process.env.AWS_REGION = 'eu-west-1';
  process.env.DELETION_QUEUE_ARN =
    'arn:aws:sqs:eu-west-1:123456789023:deletion-queue';
  process.env.SCHEDULER_ROLE_ARN =
    'arn:aws:iam::123456789023:role/publish-to-queue-role';
});

describe('test', () => {
  const cwClient = mockClient(CloudWatchLogsClient);
  const schedulerClient = mockClient(SchedulerClient);

  const event = getTestEvent({
    eventsPath: '.',
    filename: 'event',
  });

  afterEach(() => {
    cwClient.reset();
    schedulerClient.reset();
  });

  it('throws when the log group cannot be described or found', async () => {
    // Prepare
    cwClient.on(DescribeLogGroupsCommand).resolves({
      logGroups: [],
    });

    // Act & Assess
    await expect(
      handler(event as unknown as EventDetail, context)
    ).rejects.toThrow('Log group not found or does not exist');
  });
});
