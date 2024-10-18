#!/usr/bin/env node
import 'source-map-support/register';
import {
  App,
  Arn,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

const app = new App();

class CWLogsGarbageGooberStack extends Stack {
  public constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const deletionQueue = new Queue(this, 'deletion-queue', {
      queueName: 'deletion-queue',
      retentionPeriod: Duration.days(14),
    });
    const publishToQueueRole = new Role(this, 'publish-to-queue-role', {
      assumedBy: new ServicePrincipal('scheduler.amazonaws.com', {
        conditions: {
          StringEquals: {
            'aws:sourceAccount': this.account,
          },
        },
      }),
    });
    deletionQueue.grantSendMessages(publishToQueueRole);

    const fnName = 'cw-logs-event-handler';
    const cwLogsEventHandler = new NodejsFunction(
      this,
      'cw-logs-event-handler-fn',
      {
        functionName: fnName,
        entry: './src/cw-logs-event-handler.ts',
        handler: 'handler',
        runtime: Runtime.NODEJS_20_X,
        timeout: Duration.seconds(30),
        memorySize: 256,
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
          SCHEDULER_ROLE_ARN: publishToQueueRole.roleArn,
          DELETION_QUEUE_ARN: deletionQueue.queueArn,
          POWERTOOLS_LOGGER_LOG_EVENT: 'true',
          NODE_OPTIONS: '--enable-source-maps',
        },
      }
    );
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

    new Rule(this, 'CWLogsGarbageGooberRule', {
      ruleName: 'CWLogsGarbageGooberRule',
      eventPattern: {
        source: ['aws.logs'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['logs.amazonaws.com'],
          eventName: ['CreateLogGroup'],
          requestParameters: {
            logGroupName: [
              'Logger',
              'Metrics',
              'Tracer',
              'Idempotency',
              'Parameters',
              'Layers',
            ].map((packageName) => ({
              prefix: `/aws/lambda/${packageName}-`,
            })),
            tags: {
              Service: ['Powertools-for-AWS-e2e-tests'],
            },
          },
        },
      },
      targets: [new LambdaFunction(cwLogsEventHandler)],
      enabled: true,
    });
  }
}

new CWLogsGarbageGooberStack(app, 'CWLogsGarbageGoober', {
  tags: {
    Service: 'CWLogsGarbageGoober',
  },
});
