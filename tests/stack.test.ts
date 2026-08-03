import { readFileSync } from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FALLBACK_RETENTION_DAYS,
  LogGroupCleanerStack,
  loadConfig,
} from '../src/stack.js';
import type { AppConfig } from '../src/types.js';

// Synthesize with the same feature flags the CDK CLI would pick up, so that the
// template matches what is actually deployed
const { context: cdkContext } = JSON.parse(
  readFileSync(new URL('../cdk.json', import.meta.url), 'utf-8')
) as { context: Record<string, unknown> };

const config: AppConfig = {
  appName: 'TestApp',
  logGroupPatterns: ['/aws/lambda/Test-'],
  requiredTags: { Service: 'test' },
  deletionDelayDays: 1,
  fallbackRetentionDays: 7,
  slackWebhookParameter: '/test-webhook-url',
};

describe('log group cleaner stack', () => {
  const template = Template.fromStack(
    new LogGroupCleanerStack(
      new App({ context: cdkContext }),
      config.appName,
      config
    )
  );

  it('delays event processing so that retention policies have time to be applied', () => {
    // Assess - CreateLogGroup is recorded before PutRetentionPolicy is called
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'TestApp-event-processing-queue',
      DelaySeconds: 300,
    });
  });

  it('passes the fallback retention to the event handler', () => {
    // Assess
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'TestApp-event-handler',
      Environment: {
        Variables: {
          DELETION_DELAY_DAYS: '1',
          FALLBACK_RETENTION_DAYS: '7',
        },
      },
    });
  });
});

describe('loadConfig', () => {
  it('overrides the file configuration with CDK context', () => {
    // Prepare
    const app = new App({
      context: { fallbackRetentionDays: 14 },
    });

    // Act
    const result = loadConfig(app, config);

    // Assess
    expect(result.fallbackRetentionDays).toBe(14);
  });

  it('falls back to the default retention when the option is not configured', () => {
    // Prepare - simulates a config.json predating the option
    const { fallbackRetentionDays: _omitted, ...fileConfig } = config;

    // Act
    const result = loadConfig(new App(), fileConfig as AppConfig);

    // Assess
    expect(result.fallbackRetentionDays).toBe(DEFAULT_FALLBACK_RETENTION_DAYS);
    expect(result.fallbackRetentionDays).toBe(7);
  });
});
