import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  CreateScheduleCommand,
  SchedulerClient,
} from '@aws-sdk/client-scheduler';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../src/event-handler.js';
import { context, getTestEvent, wrapInSQSEvent } from './helpers.js';

vi.hoisted(() => {
  process.env.POWERTOOLS_DEV = 'true';
  process.env.AWS_REGION = 'eu-west-1';
  process.env.DELETION_QUEUE_ARN =
    'arn:aws:sqs:eu-west-1:123456789023:deletion-queue';
  process.env.SCHEDULER_ROLE_ARN =
    'arn:aws:iam::123456789023:role/publish-to-queue-role';
  process.env.DELETION_DELAY_DAYS = '1';
});

describe('cw-logs-event-handler', () => {
  const cwClient = mockClient(CloudWatchLogsClient);
  const schedulerClient = mockClient(SchedulerClient);

  const eventBridgeEvent = getTestEvent({
    eventsPath: '.',
    filename: 'event',
  });
  const sqsEvent = wrapInSQSEvent(eventBridgeEvent);

  afterEach(() => {
    cwClient.reset();
    schedulerClient.reset();
  });

  it('returns batch item failures when the log group cannot be described or found', async () => {
    // Prepare
    cwClient.on(DescribeLogGroupsCommand).resolves({
      logGroups: [],
    });

    // Act
    const result = await handler(sqsEvent, context);

    // Assess
    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0].itemIdentifier).toBe('test-message-id');
  });

  it('returns batch item failures when logGroups is undefined in response', async () => {
    // Prepare
    cwClient.on(DescribeLogGroupsCommand).resolves({});

    // Act
    const result = await handler(sqsEvent, context);

    // Assess
    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0].itemIdentifier).toBe('test-message-id');
  });

  it('creates a deletion schedule for a log group with retention', async () => {
    // Prepare
    cwClient.on(DescribeLogGroupsCommand).resolves({
      logGroups: [
        {
          logGroupName:
            '/aws/lambda/Logger-20-x86-132f7-Basic-Middy-BasicFeatures',
          retentionInDays: 7,
          arn: 'arn:aws:logs:eu-west-1:123456789023:log-group:/aws/lambda/Logger-20-x86-132f7-Basic-Middy-BasicFeatures',
        },
      ],
    });
    schedulerClient.on(CreateScheduleCommand).resolves({
      ScheduleArn:
        'arn:aws:scheduler:eu-west-1:123456789023:schedule/default/DeleteLogGroup-test',
    });

    // Act
    const result = await handler(sqsEvent, context);

    // Assess
    expect(result.batchItemFailures).toHaveLength(0);
    expect(schedulerClient).toReceiveCommandWith(CreateScheduleCommand, {
      Target: {
        Arn: 'arn:aws:sqs:eu-west-1:123456789023:deletion-queue',
        RoleArn: 'arn:aws:iam::123456789023:role/publish-to-queue-role',
        Input: expect.stringContaining(
          '/aws/lambda/Logger-20-x86-132f7-Basic-Middy-BasicFeatures'
        ),
      },
      ActionAfterCompletion: 'DELETE',
    });
  });

  it('creates a deletion schedule for a log group without retention (defaults to 0)', async () => {
    // Prepare
    cwClient.on(DescribeLogGroupsCommand).resolves({
      logGroups: [
        {
          logGroupName:
            '/aws/lambda/Logger-20-x86-132f7-Basic-Middy-BasicFeatures',
          arn: 'arn:aws:logs:eu-west-1:123456789023:log-group:/aws/lambda/Logger-20-x86-132f7-Basic-Middy-BasicFeatures',
        },
      ],
    });
    schedulerClient.on(CreateScheduleCommand).resolves({
      ScheduleArn:
        'arn:aws:scheduler:eu-west-1:123456789023:schedule/default/DeleteLogGroup-test',
    });

    // Act
    const result = await handler(sqsEvent, context);

    // Assess
    expect(result.batchItemFailures).toHaveLength(0);
    expect(schedulerClient).toReceiveCommandWith(CreateScheduleCommand, {
      FlexibleTimeWindow: {
        Mode: 'FLEXIBLE',
        MaximumWindowInMinutes: 5,
      },
    });
  });

  it('uses the correct region from the event', async () => {
    // Prepare
    cwClient.on(DescribeLogGroupsCommand).resolves({
      logGroups: [
        {
          logGroupName:
            '/aws/lambda/Logger-20-x86-132f7-Basic-Middy-BasicFeatures',
          retentionInDays: 14,
          arn: 'arn:aws:logs:eu-west-1:123456789023:log-group:/aws/lambda/Logger-20-x86-132f7-Basic-Middy-BasicFeatures',
        },
      ],
    });
    schedulerClient.on(CreateScheduleCommand).resolves({
      ScheduleArn:
        'arn:aws:scheduler:eu-west-1:123456789023:schedule/default/DeleteLogGroup-test',
    });

    // Act
    const result = await handler(sqsEvent, context);

    // Assess
    expect(result.batchItemFailures).toHaveLength(0);
    expect(cwClient).toReceiveCommandWith(DescribeLogGroupsCommand, {
      logGroupNamePrefix:
        '/aws/lambda/Logger-20-x86-132f7-Basic-Middy-BasicFeatures',
    });
  });

  it('finds exact log group match when multiple with similar prefix exist', async () => {
    // Prepare - return multiple log groups with similar prefixes
    cwClient.on(DescribeLogGroupsCommand).resolves({
      logGroups: [
        {
          logGroupName:
            '/aws/lambda/Logger-20-x86-132f7-Basic-Middy-BasicFeatures-Extra',
          retentionInDays: 30,
          arn: 'arn:aws:logs:eu-west-1:123456789023:log-group:/aws/lambda/Logger-20-x86-132f7-Basic-Middy-BasicFeatures-Extra',
        },
        {
          logGroupName:
            '/aws/lambda/Logger-20-x86-132f7-Basic-Middy-BasicFeatures',
          retentionInDays: 7,
          arn: 'arn:aws:logs:eu-west-1:123456789023:log-group:/aws/lambda/Logger-20-x86-132f7-Basic-Middy-BasicFeatures',
        },
      ],
    });
    schedulerClient.on(CreateScheduleCommand).resolves({
      ScheduleArn:
        'arn:aws:scheduler:eu-west-1:123456789023:schedule/default/DeleteLogGroup-test',
    });

    // Act
    const result = await handler(sqsEvent, context);

    // Assess - should use retention from exact match (7 days), not first result (30 days)
    expect(result.batchItemFailures).toHaveLength(0);
    expect(schedulerClient).toReceiveCommandWith(CreateScheduleCommand, {
      // Schedule should be based on 7 days retention + 1 day = 8 days from event time
      ScheduleExpression: expect.stringMatching(/^at\(2024-10-18T13:26:07\)$/),
    });
  });

  it('returns batch item failures when exact match not found even if prefix matches exist', async () => {
    // Prepare - return log groups that match prefix but not exact name
    cwClient.on(DescribeLogGroupsCommand).resolves({
      logGroups: [
        {
          logGroupName:
            '/aws/lambda/Logger-20-x86-132f7-Basic-Middy-BasicFeatures-Extra',
          retentionInDays: 30,
          arn: 'arn:aws:logs:eu-west-1:123456789023:log-group:/aws/lambda/Logger-20-x86-132f7-Basic-Middy-BasicFeatures-Extra',
        },
      ],
    });

    // Act
    const result = await handler(sqsEvent, context);

    // Assess
    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0].itemIdentifier).toBe('test-message-id');
  });
});
