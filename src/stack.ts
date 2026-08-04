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
  Metric,
  TreatMissingData,
} from 'aws-cdk-lib/aws-cloudwatch';
import { LambdaAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Rule } from 'aws-cdk-lib/aws-events';
import { SqsQueue } from 'aws-cdk-lib/aws-events-targets';
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
import type { IQueue } from 'aws-cdk-lib/aws-sqs';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';
import type { AppConfig } from './types.js';

/**
 * Retention period (in days) applied to log groups that still have no
 * retention policy when their creation event is processed, unless overridden
 * via `config.json` or CDK context
 */
const DEFAULT_FALLBACK_RETENTION_DAYS = 7;

const invalidConfig = (key: keyof AppConfig, expectation: string) =>
  new Error(`Invalid configuration "${key}": ${expectation}`);

const parseJsonOverride = (
  key: 'logGroupPatterns' | 'requiredTags',
  value: unknown,
  expectation: string
): unknown => {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    throw invalidConfig(key, expectation);
  }
};

const parseLogGroupPatterns = (value: unknown): string[] => {
  const expectation =
    'expected a JSON array of strings, for example `-c logGroupPatterns=\'["/aws/lambda/Foo-"]\'`';
  const parsed = parseJsonOverride('logGroupPatterns', value, expectation);
  if (
    !Array.isArray(parsed) ||
    parsed.some((pattern) => typeof pattern !== 'string')
  ) {
    throw invalidConfig('logGroupPatterns', expectation);
  }
  return parsed;
};

const parseRequiredTags = (value: unknown): Record<string, string> => {
  const expectation =
    'expected a JSON object with string values, for example `-c requiredTags=\'{"Environment":"staging"}\'`';
  const parsed = parseJsonOverride('requiredTags', value, expectation);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((tag) => typeof tag !== 'string')
  ) {
    throw invalidConfig('requiredTags', expectation);
  }
  return parsed as Record<string, string>;
};

const parseNumber = (
  key: 'deletionDelayDays' | 'fallbackRetentionDays',
  value: unknown
): number => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || Number.isNaN(parsed)) {
    throw invalidConfig(key, `expected a number, for example \`-c ${key}=7\``);
  }
  return parsed;
};

const parseString = (
  key: 'appName' | 'slackWebhookParameter',
  value: unknown
): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidConfig(key, 'expected a non-empty string');
  }
  return value;
};

/**
 * Merge the configuration from config.json with CDK context overrides
 *
 * @param app - CDK app used to look up context overrides
 * @param fileConfig - configuration as read from config.json
 */
const loadConfig = (app: App, fileConfig: AppConfig): AppConfig => {
  const valueFor = <Key extends keyof AppConfig>(key: Key): unknown =>
    app.node.tryGetContext(key) ?? fileConfig[key];

  return {
    appName: parseString('appName', valueFor('appName')),
    logGroupPatterns: parseLogGroupPatterns(valueFor('logGroupPatterns')),
    requiredTags: parseRequiredTags(valueFor('requiredTags')),
    deletionDelayDays: parseNumber(
      'deletionDelayDays',
      valueFor('deletionDelayDays')
    ),
    // Fall back to a sensible default so that config files predating this
    // option never end up passing `undefined` down to the event handler
    fallbackRetentionDays: parseNumber(
      'fallbackRetentionDays',
      valueFor('fallbackRetentionDays') ?? DEFAULT_FALLBACK_RETENTION_DAYS
    ),
    slackWebhookParameter: parseString(
      'slackWebhookParameter',
      valueFor('slackWebhookParameter')
    ),
  };
};

/**
 * `CreateLogGroup` is recorded by CloudTrail before `PutRetentionPolicy` is
 * called, so events are held in the event processing queue for a short while to
 * give the retention policy time to be applied before we read it.
 */
const RETENTION_SETTLE_DELAY = Duration.minutes(5);

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
      fallbackRetentionDays,
      slackWebhookParameter,
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
      visibilityTimeout: Duration.minutes(3), // 6x Lambda timeout (30 sec)
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

    // Event processing queue for throttling protection
    const eventProcessingDLQ = new Queue(this, 'event-processing-dlq', {
      queueName: `${appName}-event-processing-dlq`,
      retentionPeriod: Duration.days(14),
    });
    this.#addRequireTlsAndDenyCrossAccount({
      resource: eventProcessingDLQ,
      tlsActions: ['sqs:*'],
      denyActions: ['sqs:SendMessage'],
    });
    const eventProcessingQueue = new Queue(this, 'event-processing-queue', {
      queueName: `${appName}-event-processing-queue`,
      retentionPeriod: Duration.days(14),
      visibilityTimeout: Duration.minutes(5), // 2.5x Lambda timeout (2 min)
      // Delay the first delivery so that the retention policy applied right
      // after the log group creation is visible to the event handler
      deliveryDelay: RETENTION_SETTLE_DELAY,
      // Raw CloudTrail events and deletion commands are different message
      // shapes, so each queue dead-letters into its own DLQ to keep redrive
      // unambiguous
      deadLetterQueue: {
        queue: eventProcessingDLQ,
        maxReceiveCount: 3,
      },
    });
    this.#addRequireTlsAndDenyCrossAccount({
      resource: eventProcessingQueue,
      tlsActions: ['sqs:*'],
      denyActions: ['sqs:SendMessage'],
    });

    // Allow EventBridge to send messages to the queue
    eventProcessingQueue.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AllowEventBridge',
        effect: Effect.ALLOW,
        principals: [new ServicePrincipal('events.amazonaws.com')],
        actions: ['sqs:SendMessage'],
        resources: [eventProcessingQueue.queueArn],
      })
    );

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
        FALLBACK_RETENTION_DAYS: String(fallbackRetentionDays),
        POWERTOOLS_LOGGER_LOG_EVENT: 'false',
        NODE_OPTIONS: '--enable-source-maps',
      },
      timeout: Duration.minutes(2),
      memorySize: 512,
    });
    cwLogsEventHandler.addToRolePolicy(
      new PolicyStatement({
        actions: ['logs:DescribeLogGroups'],
        resources: [
          // The log group names are only known at runtime, so the resource
          // name stays a wildcard, but the region is the stack's own: this
          // application is single-region by construction, see the
          // `LogGroupCreationRule` below
          Arn.format(
            {
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
              'This function operates on CloudWatch log groups and Scheduler schedules whose names are only known at runtime, which requires wildcard resource names; both are scoped to this stack account and region',
            appliesTo: [
              'Resource::arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:*',
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

    // Add SQS event source for batch processing
    cwLogsEventHandler.addEventSource(
      new SqsEventSource(eventProcessingQueue, {
        batchSize: 10,
        maxConcurrency: 10,
        reportBatchItemFailures: true,
      })
    );

    // Build EventBridge rule pattern from config
    const tagFilters: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(requiredTags)) {
      tagFilters[key] = [value];
    }

    // CloudTrail records `CreateLogGroup` in the region the API call was made
    // in, and delivers the event to the default event bus of that region only.
    // This rule therefore only ever sees log groups created in the region this
    // stack is deployed to; covering more regions means deploying the stack
    // once per region.
    const rule = new Rule(this, 'LogGroupCreationRule', {
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
      targets: [new SqsQueue(eventProcessingQueue)],
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
        // `DescribeLogGroups` is needed to check whether the log group was
        // recreated after the deletion was scheduled
        actions: ['logs:DeleteLogGroup', 'logs:DescribeLogGroups'],
        resources: [
          // Same reasoning as the event handler above: wildcard log group name,
          // stack region
          Arn.format(
            {
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
              'This function deletes log groups generated by test suites, whose names are only known at runtime, so the resource name is a wildcard scoped to this stack account and region',
            appliesTo: [
              'Resource::arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:*',
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

    // Alerting via Slack Workflow Builder
    const slackNotifier = this.#createTsLambda({
      id: 'slack-workflow-notifier',
      entry: './src/slack-workflow-notifier.ts',
      fnName: `${appName}-slack-workflow-notifier`,
      environment: {
        SLACK_WEBHOOK_PARAM_NAME: slackWebhookParameter,
        APP_NAME: appName,
      },
      timeout: Duration.seconds(30),
      memorySize: 256,
    });

    // Grant SSM parameter read permissions
    //
    // The parameter is expected to be encrypted with the AWS-managed `aws/ssm`
    // key, which grants decryption to callers allowed to read the parameter.
    // A customer managed key would additionally need `kms:Decrypt` on the key
    // ARN, which cannot be expressed against the parameter ARN below
    slackNotifier.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          Arn.format(
            {
              service: 'ssm',
              resource: 'parameter',
              // Parameter names are configured with a leading slash, which the
              // ARN format already adds as the resource separator
              resourceName: slackWebhookParameter.replace(/^\//, ''),
              arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
            },
            this
          ),
        ],
      })
    );

    // Suppress CDK-nag warning for AWS managed policy usage
    if (slackNotifier.role) {
      NagSuppressions.addResourceSuppressions(slackNotifier.role, [
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'AWS managed policy AWSLambdaBasicExecutionRole is appropriate for Lambda execution role',
        },
      ]);
    }

    // Each alarm using this action gets its own `lambda:InvokeFunction`
    // permission, scoped to the alarm ARN, so no manual grant is needed
    const alarmAction = new LambdaAction(slackNotifier);

    // EventBridge rule failed invocations alarm - happens if events can't be delivered to SQS
    const ruleFailedInvocationsAlarm = new Alarm(
      this,
      'RuleFailedInvocationsAlarm',
      {
        alarmName: `${appName}-Rule-FailedInvocations`,
        alarmDescription:
          'EventBridge rule failed invocations indicate events could not be delivered to the processing queue',
        metric: new Metric({
          namespace: 'AWS/Events',
          metricName: 'FailedInvocations',
          dimensionsMap: {
            RuleName: rule.ruleName,
          },
          period: Duration.minutes(5),
          statistic: 'Sum',
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }
    );
    ruleFailedInvocationsAlarm.addAlarmAction(alarmAction);

    // Deletion DLQ alarm - any message in DLQ means permanent failure
    const dlqAlarm = new Alarm(this, 'dlq-alarm', {
      alarmName: `${appName}-DLQ-Messages`,
      alarmDescription:
        'Messages in the deletion DLQ indicate repeated deletion failures requiring investigation',
      metric: deletionDLQ.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    dlqAlarm.addAlarmAction(alarmAction);

    // Event processing DLQ alarm - these log groups are never scheduled for
    // deletion, so they would linger until someone redrives the messages
    const eventProcessingDlqAlarm = new Alarm(
      this,
      'event-processing-dlq-alarm',
      {
        alarmName: `${appName}-EventQueue-DLQ-Messages`,
        alarmDescription:
          'Messages in the event processing DLQ indicate log group creation events that could not be scheduled for deletion',
        metric: eventProcessingDLQ.metricApproximateNumberOfMessagesVisible({
          period: Duration.minutes(1),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }
    );
    eventProcessingDlqAlarm.addAlarmAction(alarmAction);

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

    // Event processing queue depth alarm
    const queueDepthAlarm = new Alarm(this, 'queue-depth-alarm', {
      alarmName: `${appName}-EventQueue-Depth`,
      alarmDescription:
        'Event processing queue has high message count indicating processing bottleneck',
      metric: eventProcessingQueue.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
      }),
      threshold: 50,
      evaluationPeriods: 2,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    queueDepthAlarm.addAlarmAction(alarmAction);

    // Event processing queue message age alarm
    const messageAgeAlarm = new Alarm(this, 'message-age-alarm', {
      alarmName: `${appName}-EventQueue-MessageAge`,
      alarmDescription:
        'Event processing queue has old messages indicating processing delays',
      metric: eventProcessingQueue.metricApproximateAgeOfOldestMessage({
        period: Duration.minutes(5),
      }),
      threshold: RETENTION_SETTLE_DELAY.toSeconds() + 300, // delivery delay + 5 minutes
      evaluationPeriods: 2,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    messageAgeAlarm.addAlarmAction(alarmAction);
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
   *  - Deny cross-account requests for specified deny actions (aws:SourceAccount != this.account)
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
    resource: IQueue;
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
          StringNotEquals: { 'aws:SourceAccount': this.account },
        },
      })
    );
  }
}

// Only bootstrap the CDK app when this file is executed as the CDK entry point
// (see `app` in cdk.json), so that the stack can be imported and synthesized in
// isolation without reading config.json
if (process.argv[1] === import.meta.filename) {
  const app = new App();
  Aspects.of(app).add(new AwsSolutionsChecks());

  const config = loadConfig(
    app,
    JSON.parse(readFileSync('./config.json', 'utf-8'))
  );

  new LogGroupCleanerStack(app, config.appName, config, {
    tags: {
      Service: config.appName,
    },
  });
}

export { DEFAULT_FALLBACK_RETENTION_DAYS, LogGroupCleanerStack, loadConfig };
