import { readFileSync } from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
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

  // Logical ID of the Slack notifier Lambda, needed to assert alarm actions
  const [slackNotifierLogicalId] =
    Object.entries(template.findResources('AWS::Lambda::Function')).find(
      ([, resource]) =>
        resource.Properties.FunctionName === 'TestApp-slack-workflow-notifier'
    ) ?? [];

  it('delays event processing so that retention policies have time to be applied', () => {
    // Assess - CreateLogGroup is recorded before PutRetentionPolicy is called
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'TestApp-event-processing-queue',
      DelaySeconds: 300,
    });
  });

  it('keeps deletion messages hidden until the handler can time out', () => {
    // Assess - six times the 30 sec deletion handler timeout
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'TestApp-deletion-queue',
      VisibilityTimeout: 180,
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

  it('lets the deletion handler look up log groups before deleting them', () => {
    // Assess - the recreation guard describes the log group before deleting it
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['logs:DeleteLogGroup', 'logs:DescribeLogGroups'],
          }),
        ]),
      }),
    });
  });

  it('grants the notifier read-only access to the webhook parameter', () => {
    // Assess - no kms:Decrypt, since it is ineffective on a parameter ARN, and
    // the partition is derived instead of hardcoded
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          {
            Action: 'ssm:GetParameter',
            Effect: 'Allow',
            Resource: {
              'Fn::Join': [
                '',
                [
                  'arn:',
                  { Ref: 'AWS::Partition' },
                  ':ssm:',
                  { Ref: 'AWS::Region' },
                  ':',
                  { Ref: 'AWS::AccountId' },
                  ':parameter/test-webhook-url',
                ],
              ],
            },
          },
        ]),
      }),
    });
  });

  it('does not grant the CloudWatch service principal invoke access', () => {
    // Assess - alarms never invoke Lambda as cloudwatch.amazonaws.com
    template.resourcePropertiesCountIs(
      'AWS::Lambda::Permission',
      { Principal: 'cloudwatch.amazonaws.com' },
      0
    );
  });

  it('lets the alarm action grant its own scoped invoke permission', () => {
    // Assess - the CDK LambdaAction scopes the permission to the alarm
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: 'lambda.alarms.cloudwatch.amazonaws.com',
      SourceAccount: { Ref: 'AWS::AccountId' },
      SourceArn: Match.anyValue(),
    });
  });

  it('configures RuleFailedInvocationsAlarm with Slack action', () => {
    // Prepare
    expect(slackNotifierLogicalId).toBeDefined();

    // Assess - Verify this alarm invokes the Slack notifier Lambda
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'TestApp-Rule-FailedInvocations',
      AlarmActions: [
        {
          'Fn::GetAtt': [slackNotifierLogicalId, 'Arn'],
        },
      ],
    });
  });

  it('dead-letters each queue into its own DLQ', () => {
    // Prepare - queues are looked up by name, logical IDs are synthesized
    const queues = Object.entries(template.findResources('AWS::SQS::Queue'));
    const logicalIdOf = (queueName: string) =>
      queues.find(([, queue]) => queue.Properties.QueueName === queueName)?.[0];
    const dlqOf = (queueName: string) =>
      queues.find(([, queue]) => queue.Properties.QueueName === queueName)?.[1]
        .Properties.RedrivePolicy?.deadLetterTargetArn['Fn::GetAtt']?.[0];

    // Assess - mixing event payloads with deletion commands would make
    // redrive send messages back to the wrong queue
    expect(logicalIdOf('TestApp-deletion-dlq')).toBeDefined();
    expect(logicalIdOf('TestApp-event-processing-dlq')).toBeDefined();
    expect(dlqOf('TestApp-deletion-queue')).toBe(
      logicalIdOf('TestApp-deletion-dlq')
    );
    expect(dlqOf('TestApp-event-processing-queue')).toBe(
      logicalIdOf('TestApp-event-processing-dlq')
    );
    expect(dlqOf('TestApp-deletion-queue')).not.toBe(
      dlqOf('TestApp-event-processing-queue')
    );
  });

  it('alarms on both DLQs via the Slack notifier', () => {
    // Prepare
    expect(slackNotifierLogicalId).toBeDefined();

    // Assess - each DLQ has its own alarm notifying Slack
    for (const alarmName of [
      'TestApp-DLQ-Messages',
      'TestApp-EventQueue-DLQ-Messages',
    ]) {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: alarmName,
        AlarmActions: [
          {
            'Fn::GetAtt': [slackNotifierLogicalId, 'Arn'],
          },
        ],
      });
    }
  });
});

describe('loadConfig', () => {
  const synthWithConfig = (app: App, stackConfig: AppConfig) =>
    Template.fromStack(
      new LogGroupCleanerStack(app, stackConfig.appName, stackConfig)
    ).toJSON();

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

  it('synthesizes JSON string collection overrides like equivalent object config', () => {
    // Prepare
    const overrideApp = new App({
      context: {
        ...cdkContext,
        logGroupPatterns: '["/aws/lambda/Override-", "/custom/logs/"]',
        requiredTags: '{"Environment":"staging","Team":"platform"}',
      },
    });
    const equivalentConfig: AppConfig = {
      ...config,
      logGroupPatterns: ['/aws/lambda/Override-', '/custom/logs/'],
      requiredTags: { Environment: 'staging', Team: 'platform' },
    };

    // Act
    const overriddenConfig = loadConfig(overrideApp, config);

    // Assess
    expect(synthWithConfig(overrideApp, overriddenConfig)).toEqual(
      synthWithConfig(new App({ context: cdkContext }), equivalentConfig)
    );
  });

  it('rejects malformed JSON with an actionable error', () => {
    const app = new App({ context: { logGroupPatterns: '["unterminated"' } });

    expect(() => loadConfig(app, config)).toThrowError(
      /logGroupPatterns.*expected a JSON array of strings.*-c logGroupPatterns=/
    );
  });

  it('rejects collection overrides with the wrong shape', () => {
    const app = new App({ context: { logGroupPatterns: '[1, 2]' } });

    expect(() => loadConfig(app, config)).toThrowError(
      /logGroupPatterns.*expected a JSON array of strings/
    );
  });

  it('parses numeric string overrides', () => {
    const app = new App({ context: { deletionDelayDays: '14' } });

    expect(loadConfig(app, config).deletionDelayDays).toBe(14);
  });

  it('rejects NaN number overrides', () => {
    const app = new App({ context: { deletionDelayDays: 'NaN' } });

    expect(() => loadConfig(app, config)).toThrowError(
      /deletionDelayDays.*expected a number.*-c deletionDelayDays=7/
    );
  });
});
