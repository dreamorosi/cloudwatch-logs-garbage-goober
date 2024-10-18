import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

export { context, getTestEvent };
