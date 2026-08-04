import type { Context } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudWatchAlarmEvent } from '../src/schemas/cloudwatch-alarm.js';

// Mock the Parameters utility
vi.mock('@aws-lambda-powertools/parameters/ssm', () => ({
  getParameter: vi.fn(),
}));

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Set environment variables before the notifier is imported
vi.hoisted(() => {
  process.env.SLACK_WEBHOOK_PARAM_NAME = '/slack-webhook-url';
  process.env.APP_NAME = 'TestApp';
});

describe('Slack Workflow Notifier', () => {
  const mockContext: Context = {
    callbackWaitsForEmptyEventLoop: false,
    functionName: 'test-function',
    functionVersion: '1',
    invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:test',
    memoryLimitInMB: '256',
    awsRequestId: 'test-request-id',
    logGroupName: '/aws/lambda/test',
    logStreamName: 'test-stream',
    getRemainingTimeInMillis: () => 30000,
    done: vi.fn(),
    fail: vi.fn(),
    succeed: vi.fn(),
  };

  const mockAlarmEvent: CloudWatchAlarmEvent = {
    source: 'aws.cloudwatch',
    alarmArn: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:TestAlarm',
    accountId: '123456789012',
    time: '2025-01-02T12:34:56.000Z',
    region: 'us-east-1',
    alarmData: {
      alarmName: 'TestAlarm',
      state: {
        value: 'ALARM',
        timestamp: '2025-01-02T12:34:56.000Z',
        reason: 'Test alarm reason',
      },
      configuration: {
        description: 'Test alarm description',
      },
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    const { getParameter } = await import(
      '@aws-lambda-powertools/parameters/ssm'
    );
    vi.mocked(getParameter).mockResolvedValue(
      'https://hooks.slack.com/test-webhook'
    );

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('should process ALARM state and send to Slack', async () => {
    const { handler } = await import('../src/slack-workflow-notifier.js');
    const { getParameter } = await import(
      '@aws-lambda-powertools/parameters/ssm'
    );

    await handler(mockAlarmEvent, mockContext);

    expect(getParameter).toHaveBeenCalledWith('/slack-webhook-url', {
      decrypt: true,
      maxAge: 300,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://hooks.slack.com/test-webhook',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: expect.stringContaining('"emoji":"🚨"'),
      })
    );

    const fetchCall = mockFetch.mock.calls[0];
    const payload = JSON.parse(fetchCall[1].body);

    expect(payload).toEqual({
      emoji: '🚨',
      alarmName: 'TestAlarm',
      alarmDescription: 'Test alarm description',
      cloudWatchUrl:
        'https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#alarmsV2:alarm/TestAlarm',
      region: 'us-east-1',
      alarmTime: '2025-01-02 12:34:56 UTC',
      appName: 'TestApp',
    });
  });

  it('should skip non-ALARM states', async () => {
    const { handler } = await import('../src/slack-workflow-notifier.js');
    const { getParameter } = await import(
      '@aws-lambda-powertools/parameters/ssm'
    );

    const okEvent = {
      ...mockAlarmEvent,
      alarmData: {
        ...mockAlarmEvent.alarmData,
        state: {
          ...mockAlarmEvent.alarmData.state,
          value: 'OK' as const,
        },
      },
    };

    await handler(okEvent, mockContext);

    expect(getParameter).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should reject when the webhook URL is unavailable', async () => {
    const { getParameter } = await import(
      '@aws-lambda-powertools/parameters/ssm'
    );
    vi.mocked(getParameter).mockResolvedValue(undefined);
    const { handler } = await import('../src/slack-workflow-notifier.js');

    await expect(handler(mockAlarmEvent, mockContext)).rejects.toThrow(
      'Webhook URL not available'
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should reject an invalid alarm ARN before sending to Slack', async () => {
    const { handler } = await import('../src/slack-workflow-notifier.js');
    const invalidArnEvent = {
      ...mockAlarmEvent,
      alarmArn: 'invalid-arn',
    };

    await expect(handler(invalidArnEvent, mockContext)).rejects.toThrow(
      'Invalid alarm ARN format: invalid-arn'
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should retry a failed HTTP response', async () => {
    vi.useFakeTimers();
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
      });

    const { handler } = await import('../src/slack-workflow-notifier.js');
    const handlerPromise = handler(mockAlarmEvent, mockContext);

    await vi.advanceTimersByTimeAsync(1000);
    await handlerPromise;

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should retry a timed-out webhook request with an abort signal', async () => {
    vi.useFakeTimers();
    mockFetch
      .mockRejectedValueOnce(
        new DOMException('The operation timed out', 'TimeoutError')
      )
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
      });

    const { handler } = await import('../src/slack-workflow-notifier.js');
    const handlerPromise = handler(mockAlarmEvent, mockContext);

    await vi.advanceTimersByTimeAsync(1000);
    await handlerPromise;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][1]).toEqual(
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(mockFetch.mock.calls[1][1]).toEqual(
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('should reject after exhausting all retries', async () => {
    vi.useFakeTimers();
    const webhookError = new Error('Slack is unavailable');
    mockFetch.mockRejectedValue(webhookError);

    const { handler } = await import('../src/slack-workflow-notifier.js');
    const handlerPromise = handler(mockAlarmEvent, mockContext);
    const rejection = expect(handlerPromise).rejects.toThrow(webhookError);

    await vi.advanceTimersByTimeAsync(7000);
    await rejection;

    expect(mockFetch).toHaveBeenCalledTimes(4);
  });
});
