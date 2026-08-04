import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  CreateScheduleCommand,
  SchedulerClient,
} from '@aws-sdk/client-scheduler';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
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
  process.env.FALLBACK_RETENTION_DAYS = '30';
});

describe('cw-logs-event-handler', () => {
  const cwClient = mockClient(CloudWatchLogsClient);
  const schedulerClient = mockClient(SchedulerClient);

  const eventBridgeEvent = getTestEvent({
    eventsPath: '.',
    filename: 'event',
  });
  const sqsEvent = wrapInSQSEvent(eventBridgeEvent);

  /**
   * Invoke the handler and narrow the response to the SQS batch response
   */
  const invokeHandler = async (event: SQSEvent) =>
    (await handler(event, context, () => {})) as SQSBatchResponse;

  afterEach(() => {
    cwClient.reset();
    schedulerClient.reset();
    vi.clearAllMocks();
  });

  it('treats an already-deleted log group as success', async () => {
    // Prepare
    cwClient.on(DescribeLogGroupsCommand).resolves({
      logGroups: [],
    });

    // Act
    const result = await invokeHandler(sqsEvent);

    // Assess
    expect(result.batchItemFailures).toHaveLength(0);
    expect(schedulerClient.commandCalls(CreateScheduleCommand)).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Log group not found, skipping schedule creation')
    );
    const warning = vi.mocked(console.warn).mock.calls[0][0];
    expect(warning).toContain(
      '/aws/lambda/Logger-20-x86-132f7-Basic-Middy-BasicFeatures'
    );
    expect(warning).toContain('eu-west-1');
  });

  it('treats an undefined logGroups response as success', async () => {
    // Prepare
    cwClient.on(DescribeLogGroupsCommand).resolves({});

    // Act
    const result = await invokeHandler(sqsEvent);

    // Assess
    expect(result.batchItemFailures).toHaveLength(0);
    expect(schedulerClient.commandCalls(CreateScheduleCommand)).toHaveLength(0);
  });

  it('returns batch item failures when the log group lookup fails', async () => {
    // Prepare
    cwClient
      .on(DescribeLogGroupsCommand)
      .rejects(new Error('CloudWatch Logs access denied'));

    // Act
    const result = await invokeHandler(sqsEvent);

    // Assess
    expect(result.batchItemFailures).toEqual([
      { itemIdentifier: 'test-message-id' },
    ]);
    expect(schedulerClient.commandCalls(CreateScheduleCommand)).toHaveLength(0);
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
    const result = await invokeHandler(sqsEvent);

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

  it('schedules based on the retention set after the log group was created', async () => {
    // Prepare - the retention policy is applied shortly after CreateLogGroup,
    // so it is already in place by the time the delayed event is processed
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
    const result = await invokeHandler(sqsEvent);

    // Assess - event time (2024-10-10T13:26:07Z) + 7 days retention + 1 day delay
    expect(result.batchItemFailures).toHaveLength(0);
    expect(schedulerClient).toReceiveCommandWith(CreateScheduleCommand, {
      ScheduleExpression: 'at(2024-10-18T13:26:07)',
    });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('applies the fallback retention when the log group has no retention', async () => {
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
    const result = await invokeHandler(sqsEvent);

    // Assess - event time (2024-10-10T13:26:07Z) + 30 days fallback + 1 day delay
    expect(result.batchItemFailures).toHaveLength(0);
    expect(schedulerClient).toReceiveCommandWith(CreateScheduleCommand, {
      ScheduleExpression: 'at(2024-11-10T13:26:07)',
      FlexibleTimeWindow: {
        Mode: 'FLEXIBLE',
        MaximumWindowInMinutes: 5,
      },
    });
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Log group has no retention policy')
    );
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
    const result = await invokeHandler(sqsEvent);

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
    const result = await invokeHandler(sqsEvent);

    // Assess - should use retention from exact match (7 days), not first result (30 days)
    expect(result.batchItemFailures).toHaveLength(0);
    expect(schedulerClient).toReceiveCommandWith(CreateScheduleCommand, {
      // Schedule should be based on 7 days retention + 1 day = 8 days from event time
      ScheduleExpression: expect.stringMatching(/^at\(2024-10-18T13:26:07\)$/),
    });
  });

  it('includes the log group creation time in the schedule payload', async () => {
    // Prepare
    cwClient.on(DescribeLogGroupsCommand).resolves({
      logGroups: [
        {
          logGroupName:
            '/aws/lambda/Logger-20-x86-132f7-Basic-Middy-BasicFeatures',
          retentionInDays: 7,
          creationTime: 1_728_566_767_000,
          arn: 'arn:aws:logs:eu-west-1:123456789023:log-group:/aws/lambda/Logger-20-x86-132f7-Basic-Middy-BasicFeatures',
        },
      ],
    });
    schedulerClient.on(CreateScheduleCommand).resolves({
      ScheduleArn:
        'arn:aws:scheduler:eu-west-1:123456789023:schedule/default/DeleteLogGroup-test',
    });

    // Act
    const result = await invokeHandler(sqsEvent);

    // Assess - the deletion handler uses the creation time to make sure it does
    // not delete a newer log group that reuses the same name
    expect(result.batchItemFailures).toHaveLength(0);
    expect(schedulerClient).toReceiveCommandWith(CreateScheduleCommand, {
      Target: expect.objectContaining({
        Input: JSON.stringify({
          logGroupName:
            '/aws/lambda/Logger-20-x86-132f7-Basic-Middy-BasicFeatures',
          awsRegion: 'eu-west-1',
          creationTime: 1_728_566_767_000,
        }),
      }),
    });
  });

  it('finds the log group when the exact match is on a later page', async () => {
    // Prepare - more log groups share the prefix than fit in a single
    // `DescribeLogGroups` page, and the exact match is on the second one
    cwClient
      .on(DescribeLogGroupsCommand)
      .resolvesOnce({
        logGroups: [
          {
            logGroupName:
              '/aws/lambda/Logger-20-x86-132f7-Basic-Middy-BasicFeatures-Extra',
            retentionInDays: 30,
          },
        ],
        nextToken: 'page-2',
      })
      .resolvesOnce({
        logGroups: [
          {
            logGroupName:
              '/aws/lambda/Logger-20-x86-132f7-Basic-Middy-BasicFeatures',
            retentionInDays: 7,
          },
        ],
      });
    schedulerClient.on(CreateScheduleCommand).resolves({
      ScheduleArn:
        'arn:aws:scheduler:eu-west-1:123456789023:schedule/default/DeleteLogGroup-test',
    });

    // Act
    const result = await invokeHandler(sqsEvent);

    // Assess - the exact match from the second page is used (7 days retention)
    expect(result.batchItemFailures).toHaveLength(0);
    expect(cwClient.commandCalls(DescribeLogGroupsCommand)).toHaveLength(2);
    expect(schedulerClient).toReceiveCommandWith(CreateScheduleCommand, {
      ScheduleExpression: 'at(2024-10-18T13:26:07)',
    });
  });

  it('stops paginating as soon as the exact match is found', async () => {
    // Prepare - the first page contains the exact match, but more pages exist
    cwClient.on(DescribeLogGroupsCommand).resolves({
      logGroups: [
        {
          logGroupName:
            '/aws/lambda/Logger-20-x86-132f7-Basic-Middy-BasicFeatures',
          retentionInDays: 7,
        },
      ],
      nextToken: 'page-2',
    });
    schedulerClient.on(CreateScheduleCommand).resolves({
      ScheduleArn:
        'arn:aws:scheduler:eu-west-1:123456789023:schedule/default/DeleteLogGroup-test',
    });

    // Act
    const result = await invokeHandler(sqsEvent);

    // Assess
    expect(result.batchItemFailures).toHaveLength(0);
    expect(cwClient.commandCalls(DescribeLogGroupsCommand)).toHaveLength(1);
    expect(schedulerClient.commandCalls(CreateScheduleCommand)).toHaveLength(1);
  });

  it('skips scheduling when exact match not found even if prefix matches exist', async () => {
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
    const result = await invokeHandler(sqsEvent);

    // Assess
    expect(result.batchItemFailures).toHaveLength(0);
    expect(schedulerClient.commandCalls(CreateScheduleCommand)).toHaveLength(0);
  });

  it('skips scheduling when the exact match is missing from every page', async () => {
    // Prepare - several pages of prefix matches, none of them the exact name
    cwClient
      .on(DescribeLogGroupsCommand)
      .resolvesOnce({
        logGroups: [
          {
            logGroupName:
              '/aws/lambda/Logger-20-x86-132f7-Basic-Middy-BasicFeatures-Extra',
          },
        ],
        nextToken: 'page-2',
      })
      .resolvesOnce({
        logGroups: [
          {
            logGroupName:
              '/aws/lambda/Logger-20-x86-132f7-Basic-Middy-BasicFeatures-Other',
          },
        ],
      });

    // Act
    const result = await invokeHandler(sqsEvent);

    // Assess
    expect(result.batchItemFailures).toHaveLength(0);
    expect(cwClient.commandCalls(DescribeLogGroupsCommand)).toHaveLength(2);
    expect(schedulerClient.commandCalls(CreateScheduleCommand)).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Log group not found, skipping schedule creation')
    );
  });
});
