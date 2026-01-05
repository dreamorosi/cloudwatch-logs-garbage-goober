import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SQSEvent } from 'aws-lambda';

const context = {
  callbackWaitsForEmptyEventLoop: true,
  functionVersion: '$LATEST',
  functionName: 'foo-bar-function',
  memoryLimitInMB: '128',
  logGroupName: '/aws/lambda/foo-bar-function-123456abcdef',
  logStreamName: '2021/03/09/[$LATEST]abcdef123456abcdef123456abcdef123456',
  invokedFunctionArn:
    'arn:aws:lambda:eu-west-1:123456789012:function:foo-bar-function',
  awsRequestId: 'c6af9ac6-7b61-11e6-9a41-93e812345678',
  getRemainingTimeInMillis: () => 1234,
  done: () => console.log('Done!'),
  fail: () => console.log('Failed!'),
  succeed: () => console.log('Succeeded!'),
};

const getTestEvent = <T extends Record<string, unknown>>({
  eventsPath,
  filename,
}: {
  eventsPath: string;
  filename: string;
}): T =>
  JSON.parse(
    readFileSync(join(__dirname, eventsPath, `${filename}.json`), 'utf-8')
  ) as T;

/**
 * Wrap an EventBridge event in SQS event format for testing
 */
const wrapInSQSEvent = (
  eventBridgeEvent: Record<string, unknown>
): SQSEvent => ({
  Records: [
    {
      messageId: 'test-message-id',
      receiptHandle: 'test-receipt-handle',
      body: JSON.stringify(eventBridgeEvent),
      attributes: {
        ApproximateReceiveCount: '1',
        SentTimestamp: '1545082649183',
        SenderId: 'AIDAIENQZJOLO23YVJ4VO',
        ApproximateFirstReceiveTimestamp: '1545082649185',
      },
      messageAttributes: {},
      md5OfBody: 'test-md5',
      eventSource: 'aws:sqs',
      eventSourceARN: 'arn:aws:sqs:us-east-2:123456789012:test-queue',
      awsRegion: 'eu-west-1',
    },
  ],
});

export { context, getTestEvent, wrapInSQSEvent };
