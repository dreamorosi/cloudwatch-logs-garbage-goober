#!/usr/bin/env node
import 'source-map-support/register.js';
import { readFileSync } from 'node:fs';
import { TypeScriptCode } from '@mrgrain/cdk-esbuild';
import {
  App,
  Arn,
  ArnFormat,
  Aspects,
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
import {
  AnyPrincipal,
  Effect,
  PolicyStatement,
  type PolicyStatementProps,
  Role,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import {
  type FunctionProps,
  Function as LambdaFn,
  Runtime,
} from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import type { IQueue } from 'aws-cdk-lib/aws-sqs';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';
import type { AppConfig } from './types.js';

const app = new App();
Aspects.of(app).add(new AwsSolutionsChecks());

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

    this.#addRequireTlsAndDenyCrossAccount({
      resource: deletionDLQ,
      tlsActions: ['sqs:*'],
      denyActions: ['sqs:SendMessage'],
    });
    const deletionQueue = new Queue(this, 'deletion-queue', {
      queueName: `${appName}-deletion-queue`,
      retentionPeriod: Duration.days(14),
      deadLetterQueue: {
        queue: deletionDLQ,
        maxReceiveCount: 3,
      },
    });
    this.#addRequireTlsAndDenyCrossAccount({
      resource: deletionQueue,
      tlsActions: ['sqs:*'],
      denyActions: ['sqs:SendMessage'],
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
    const cwLogsEventHandler = this.#createTsLambda({
      id: 'event-handler-fn',
      entry: './src/event-handler.ts',
      fnName,
      environment: {
        POWERTOOLS_SERVICE_NAME: appName,
        SCHEDULER_ROLE_ARN: publishToQueueRole.roleArn,
        DELETION_QUEUE_ARN: deletionQueue.queueArn,
        DELETION_DELAY_DAYS: String(deletionDelayDays),
        POWERTOOLS_LOGGER_LOG_EVENT: 'false',
        NODE_OPTIONS: '--enable-source-maps',
      },
      timeout: Duration.seconds(30),
      memorySize: 512,
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

    // Suppressions for cdk-nag on this function's role
    if (cwLogsEventHandler.role) {
      NagSuppressions.addResourceSuppressions(
        cwLogsEventHandler.role,
        [
          {
            id: 'AwsSolutions-IAM4',
            reason:
              'Default AWS managed policy AWSLambdaBasicExecutionRole is acceptable for lambda execution role',
            appliesTo: [
              'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
            ],
          },
          {
            id: 'AwsSolutions-IAM5',
            reason:
              'This function must be able to operate on arbitrary CloudWatch log groups and Scheduler schedules, which requires wildcard resources',
            appliesTo: [
              'Resource::arn:<AWS::Partition>:logs:*:<AWS::AccountId>:log-group:*',
              'Resource::arn:<AWS::Partition>:scheduler:<AWS::Region>:<AWS::AccountId>:schedule/*',
            ],
          },
        ],
        true
      );
    }
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
    const deletionHandler = this.#createTsLambda({
      id: 'deletion-handler-fn',
      entry: './src/deletion-handler.ts',
      fnName: deletionHandlerFnName,
      environment: {
        POWERTOOLS_SERVICE_NAME: appName,
        POWERTOOLS_LOGGER_LOG_EVENT: 'false',
        NODE_OPTIONS: '--enable-source-maps',
      },
      timeout: Duration.seconds(30),
      memorySize: 512,
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

    // Suppressions for cdk-nag on deletion handler role
    if (deletionHandler.role) {
      NagSuppressions.addResourceSuppressions(
        deletionHandler.role,
        [
          {
            id: 'AwsSolutions-IAM4',
            reason:
              'Default AWS managed policy AWSLambdaBasicExecutionRole is acceptable for lambda execution role',
            appliesTo: [
              'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
            ],
          },
          {
            id: 'AwsSolutions-IAM5',
            reason:
              'This function needs wildcard access to CloudWatch log groups to delete arbitrary log groups generated by test suites',
            appliesTo: [
              'Resource::arn:<AWS::Partition>:logs:*:<AWS::AccountId>:log-group:*',
            ],
          },
        ],
        true
      );
    }
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
    this.#addRequireTlsAndDenyCrossAccount({
      resource: alertTopic,
      tlsActions: ['sns:Publish'],
      denyActions: ['sns:Publish'],
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

  /**
   * Create a TypeScript-built Lambda function using `cdk-esbuild`'s TypeScriptCode helper.
   *
   * Keeps common configuration minimal while allowing overrides for environment, timeout, and memory.
   *
   * @param options - build options for the Function
   * @param options.id - construct id
   * @param options.entry - path to the TypeScript handler file (relative to project root)
   * @param options.fnName - logical function name (used for the function and its log group)
   */
  #createTsLambda({
    id,
    entry,
    fnName,
    ...props
  }: {
    id: string;
    entry: string;
    fnName: NonNullable<FunctionProps['functionName']>;
  } & Partial<FunctionProps>) {
    // Extract handler name from entry path (e.g., './src/event-handler.ts' -> 'event-handler')
    const handlerBasename =
      entry.split('/').pop()?.replace('.ts', '') ?? 'index';

    const defaults = {
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: {},
    } as const;

    return new LambdaFn(this, id, {
      ...defaults,
      ...props,
      // non-overridable props
      functionName: fnName,
      runtime: Runtime.NODEJS_24_X,
      handler: `${handlerBasename}.handler`,
      code: new TypeScriptCode(entry, {
        buildOptions: {
          minify: true,
          sourcemap: true,
          format: 'esm',
          mainFields: ['module', 'main'],
          outExtension: { '.js': '.mjs' },
        },
      }),
      logGroup: new LogGroup(this, `${id}-LogGroup`, {
        logGroupName: `/aws/lambda/${fnName}`,
        removalPolicy: RemovalPolicy.DESTROY,
        retention: RetentionDays.ONE_WEEK,
      }),
    });
  }

  /**
   * Adds two DENY statements to a resource's policy:
   *  - Deny non-TLS requests for specified actions (aws:SecureTransport = false)
   *  - Deny cross-account requests for specified deny actions (aws:PrincipalAccount != this.account)
   *
   * @param options - options object
   * @param options.resource - object with addToResourcePolicy method (Queue or Topic)
   * @param options.tlsActions - actions to include in the TLS DENY (e.g., ['sqs:*'])
   * @param options.denyActions - actions to include in cross-account DENY (e.g., ['sqs:SendMessage'])
   */
  #addRequireTlsAndDenyCrossAccount({
    resource,
    tlsActions,
    denyActions,
  }: {
    resource: IQueue | ITopic;
    tlsActions: PolicyStatementProps['actions'];
    denyActions: PolicyStatementProps['actions'];
  }) {
    resource.addToResourcePolicy(
      new PolicyStatement({
        sid: 'RequireTLS',
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        actions: tlsActions,
        resources: ['*'],
        conditions: {
          Bool: { 'aws:SecureTransport': 'false' },
        },
      })
    );

    resource.addToResourcePolicy(
      new PolicyStatement({
        sid: 'DenyCrossAccount',
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        actions: denyActions,
        resources: ['*'],
        conditions: {
          StringNotEquals: { 'aws:PrincipalAccount': this.account },
        },
      })
    );
  }
}

new LogGroupCleanerStack(app, config.appName, config, {
  tags: {
    Service: config.appName,
  },
});
