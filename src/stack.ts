#!/usr/bin/env node
import 'source-map-support/register.js';
import { readFileSync } from 'node:fs';
import {
  App,
  Arn,
  ArnFormat,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import {
  Alarm,
  ComparisonOperator,
  TreatMissingData,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import type { AppConfig } from './types.js';

const app = new App();

/**
 * Load configuration from config.json with CDK context overrides
 */
const loadConfig = (app: App): AppConfig => {
  const fileConfig: AppConfig = JSON.parse(
    readFileSync('./config.json', 'utf-8')
  );

  return {
    appName: app.node.tryGetContext('appName') ?? fileConfig.appName,
    logGroupPatterns:
      app.node.tryGetContext('logGroupPatterns') ?? fileConfig.logGroupPatterns,
    requiredTags:
      app.node.tryGetContext('requiredTags') ?? fileConfig.requiredTags,
    deletionDelayDays:
      app.node.tryGetContext('deletionDelayDays') ??
      fileConfig.deletionDelayDays,
    alertsEmailParameter:
      app.node.tryGetContext('alertsEmailParameter') ??
      fileConfig.alertsEmailParameter,
  };
};

const config = loadConfig(app);

class LogGroupCleanerStack extends Stack {
  public constructor(
    scope: Construct,
    id: string,
    config: AppConfig,
    props?: StackProps
  ) {
    super(scope, id, props);

    const {
      appName,
      logGroupPatterns,
      requiredTags,
      deletionDelayDays,
      alertsEmailParameter,
    } = config;

    const deletionDLQ = new Queue(this, 'deletion-dlq', {
      queueName: `${appName}-deletion-dlq`,
      retentionPeriod: Duration.days(14),
    });
    const deletionQueue = new Queue(this, 'deletion-queue', {
      queueName: `${appName}-deletion-queue`,
      retentionPeriod: Duration.days(14),
      deadLetterQueue: {
        queue: deletionDLQ,
        maxReceiveCount: 3,
      },
    });
    const publishToQueueRole = new Role(this, 'publish-to-queue-role', {
      roleName: `${appName}-publish-to-queue-role`,
      assumedBy: new ServicePrincipal('scheduler.amazonaws.com', {
        conditions: {
          StringEquals: {
            'aws:sourceAccount': this.account,
          },
        },
      }),
    });
    deletionQueue.grantSendMessages(publishToQueueRole);

    const fnName = `${appName}-event-handler`;
    const cwLogsEventHandler = new NodejsFunction(this, 'event-handler-fn', {
      functionName: fnName,
      entry: './src/event-handler.ts',
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      timeout: Duration.seconds(30),
      memorySize: 512,
      bundling: {
        minify: true,
        mainFields: ['module', 'main'],
        sourceMap: true,
        format: OutputFormat.ESM,
      },
      logGroup: new LogGroup(this, 'MyLogGroup', {
        logGroupName: `/aws/lambda/${fnName}`,
        removalPolicy: RemovalPolicy.DESTROY,
        retention: RetentionDays.ONE_WEEK,
      }),
      environment: {
        POWERTOOLS_SERVICE_NAME: appName,
        SCHEDULER_ROLE_ARN: publishToQueueRole.roleArn,
        DELETION_QUEUE_ARN: deletionQueue.queueArn,
        DELETION_DELAY_DAYS: String(deletionDelayDays),
        POWERTOOLS_LOGGER_LOG_EVENT: 'false',
        NODE_OPTIONS: '--enable-source-maps',
      },
    });
    cwLogsEventHandler.addToRolePolicy(
      new PolicyStatement({
        actions: ['logs:DescribeLogGroups'],
        resources: [
          Arn.format(
            {
              region: '*',
              service: 'logs',
              resource: 'log-group',
              resourceName: '*',
              arnFormat: ArnFormat.COLON_RESOURCE_NAME,
            },
            this
          ),
        ],
      })
    );
    cwLogsEventHandler.addToRolePolicy(
      new PolicyStatement({
        actions: ['scheduler:CreateSchedule'],
        resources: [
          Arn.format(
            {
              service: 'scheduler',
              resource: 'schedule',
              resourceName: '*',
            },
            this
          ),
        ],
      })
    );
    cwLogsEventHandler.addToRolePolicy(
      new PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [publishToQueueRole.roleArn],
      })
    );

    // Build EventBridge rule pattern from config
    const tagFilters: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(requiredTags)) {
      tagFilters[key] = [value];
    }

    new Rule(this, 'LogGroupCreationRule', {
      ruleName: `${appName}-Rule`,
      eventPattern: {
        source: ['aws.logs'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['logs.amazonaws.com'],
          eventName: ['CreateLogGroup'],
          requestParameters: {
            logGroupName: logGroupPatterns.map((pattern) => ({
              prefix: pattern,
            })),
            tags: tagFilters,
          },
        },
      },
      targets: [new LambdaFunction(cwLogsEventHandler)],
      enabled: true,
    });

    const deletionHandlerFnName = `${appName}-deletion-handler`;
    const deletionHandler = new NodejsFunction(this, 'deletion-handler-fn', {
      functionName: deletionHandlerFnName,
      entry: './src/deletion-handler.ts',
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      timeout: Duration.seconds(30),
      memorySize: 512,
      bundling: {
        minify: true,
        mainFields: ['module', 'main'],
        sourceMap: true,
        format: OutputFormat.ESM,
      },
      logGroup: new LogGroup(this, 'DeletionHandlerLogGroup', {
        logGroupName: `/aws/lambda/${deletionHandlerFnName}`,
        removalPolicy: RemovalPolicy.DESTROY,
        retention: RetentionDays.ONE_WEEK,
      }),
      environment: {
        POWERTOOLS_SERVICE_NAME: appName,
        POWERTOOLS_LOGGER_LOG_EVENT: 'false',
        NODE_OPTIONS: '--enable-source-maps',
      },
    });
    deletionHandler.addToRolePolicy(
      new PolicyStatement({
        actions: ['logs:DeleteLogGroup'],
        resources: [
          Arn.format(
            {
              region: '*',
              service: 'logs',
              resource: 'log-group',
              resourceName: '*',
              arnFormat: ArnFormat.COLON_RESOURCE_NAME,
            },
            this
          ),
        ],
      })
    );
    deletionHandler.addEventSource(
      new SqsEventSource(deletionQueue, {
        reportBatchItemFailures: true,
      })
    );

    // Alerting
    const alertEmail = StringParameter.valueForStringParameter(
      this,
      alertsEmailParameter
    );
    const alertTopic = new Topic(this, 'alert-topic', {
      topicName: `${appName}-alerts`,
    });
    alertTopic.addSubscription(new EmailSubscription(alertEmail));
    const alarmAction = new SnsAction(alertTopic);

    // DLQ alarm - any message in DLQ means permanent failure
    const dlqAlarm = new Alarm(this, 'dlq-alarm', {
      alarmName: `${appName}-DLQ-Messages`,
      alarmDescription:
        'Messages in DLQ indicate repeated deletion failures requiring investigation',
      metric: deletionDLQ.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    dlqAlarm.addAlarmAction(alarmAction);

    // Event handler errors alarm
    const eventHandlerErrorAlarm = new Alarm(
      this,
      'event-handler-error-alarm',
      {
        alarmName: `${appName}-EventHandler-Errors`,
        alarmDescription: 'Event handler Lambda is experiencing errors',
        metric: cwLogsEventHandler.metricErrors({
          period: Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }
    );
    eventHandlerErrorAlarm.addAlarmAction(alarmAction);

    // Deletion handler errors alarm
    const deletionHandlerErrorAlarm = new Alarm(
      this,
      'deletion-handler-error-alarm',
      {
        alarmName: `${appName}-DeletionHandler-Errors`,
        alarmDescription: 'Deletion handler Lambda is experiencing errors',
        metric: deletionHandler.metricErrors({
          period: Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }
    );
    deletionHandlerErrorAlarm.addAlarmAction(alarmAction);
  }
}

new LogGroupCleanerStack(app, config.appName, config, {
  tags: {
    Service: config.appName,
  },
});
