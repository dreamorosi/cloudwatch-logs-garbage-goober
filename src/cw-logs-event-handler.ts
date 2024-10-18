import { randomUUID } from 'node:crypto';
import { addUserAgentMiddleware } from '@aws-lambda-powertools/commons';
import type {
  AsyncHandler,
  HandlerMethodDecorator,
  LambdaInterface,
} from '@aws-lambda-powertools/commons/types';
import { Logger } from '@aws-lambda-powertools/logger';
import { parser } from '@aws-lambda-powertools/parser';
import { EventBridgeEnvelope } from '@aws-lambda-powertools/parser/envelopes';
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  ActionAfterCompletion,
  CreateScheduleCommand,
  FlexibleTimeWindowMode,
  SchedulerClient,
} from '@aws-sdk/client-scheduler';
import type { Context, Handler } from 'aws-lambda';
import { Temporal } from 'temporal-polyfill';
import { z } from 'zod';

const logger = new Logger();
const schedulerClient = new SchedulerClient();
addUserAgentMiddleware(schedulerClient, 'NO-OP');

const EventDetailSchema = z.object({
  eventTime: z.string(),
  awsRegion: z.string(),
  requestParameters: z.object({
    logGroupName: z.string(),
  }),
});
export type EventDetail = z.infer<typeof EventDetailSchema>;
type EventContext = {
  awsRegion: EventDetail['awsRegion'];
  eventTime?: EventDetail['eventTime'];
  logGroupName?: EventDetail['requestParameters']['logGroupName'];
  deletionQueueArn: string;
  schedulerRoleArn: string;
};

class Lambda implements LambdaInterface {
  #cwClientMap = new Map<string, CloudWatchLogsClient>();
  #context: EventContext = {
    awsRegion: process.env.AWS_REGION,
    deletionQueueArn: Lambda.getStringFromEnv('DELETION_QUEUE_ARN'),
    schedulerRoleArn: Lambda.getStringFromEnv('SCHEDULER_ROLE_ARN'),
  };

  /**
   * Create an Amazon EventBridge rule to delete the log group after the retention period + 1 day
   *
   * @param retentionInDays - The number of days to retain logs for
   */
  async #createDeleteSchedule(retentionInDays: number) {
    const retentionDate = Temporal.Instant.from(
      this.#getContextKey('eventTime')
    )
      .toZonedDateTimeISO('UTC')
      .add({ days: retentionInDays + 1 })
      .toInstant();

    const testName = this.#getContextKey('logGroupName')
      .split('/aws/lambda/')[1]
      .substring(0, 18);

    await schedulerClient.send(
      new CreateScheduleCommand({
        ScheduleExpression: `at(${retentionDate.toString().replace('Z', '')})`,
        FlexibleTimeWindow: {
          Mode: FlexibleTimeWindowMode.FLEXIBLE,
          MaximumWindowInMinutes: 5,
        },
        Name: `DeleteLogGroup-${testName}-${randomUUID().substring(0, 5)}`,
        Target: {
          RoleArn: this.#getContextKey('schedulerRoleArn'),
          Arn: this.#getContextKey('deletionQueueArn'),
          Input: JSON.stringify({
            logGroupName: this.#getContextKey('logGroupName'),
            awsRegion: this.#getContextKey('awsRegion'),
          }),
        },
        ActionAfterCompletion: ActionAfterCompletion.DELETE,
      })
    );
  }

  /**
   * Fetch log group info for the given log group name
   */
  async #fetchLogGroupInfo() {
    const cwClient = this.#getRegionalCwClient();

    const response = await cwClient.send(
      new DescribeLogGroupsCommand({
        logGroupNamePrefix: this.#getContextKey('logGroupName'),
      })
    );
    logger.debug('Log group info', { response: response.logGroups || [] });

    const logGroup = response.logGroups?.[0];
    if (!logGroup) {
      const message = 'Log group not found or does not exist';
      logger.error(message);
      throw new Error(message);
    }

    return logGroup;
  }

  /**
   * Get a key from the environment, throwing an error if it's missing
   *
   * @param key - The key to retrieve from the environment
   */
  static getStringFromEnv(key: string) {
    const value = process.env[key];
    if (!value) {
      throw new Error(`${key} is missing`);
    }

    return value;
  }

  /**
   * Get a key from the context, throwing an error if it's missing
   *
   * @param key - The key to retrieve from the context
   */
  #getContextKey(key: keyof EventContext) {
    const value = this.#context[key];
    if (value === undefined) {
      throw new Error(`Context key ${key} is missing`);
    }

    return value;
  }

  /**
   * Get or create a CloudWatchLogsClient for the given AWS region
   */
  #getRegionalCwClient() {
    let cwClient = this.#cwClientMap.get(this.#context.awsRegion);
    if (!cwClient) {
      logger.trace('Creating new CloudWatchLogsClient for region');
      cwClient = new CloudWatchLogsClient({ region: this.#context.awsRegion });
      addUserAgentMiddleware(cwClient, 'NO-OP');
      this.#cwClientMap.set(this.#context.awsRegion, cwClient);
    } else {
      logger.trace('Reusing CloudWatchLogsClient for region');
    }

    return cwClient;
  }

  /**
   * Register the event context for the current invocation
   *
   * The context is used to store information about the current event
   * and is cleared after the handler is done processing the event
   *
   * @param event - The AWS Lambda event
   */
  #registerEventContext(event: EventDetail) {
    const {
      awsRegion,
      eventTime,
      requestParameters: { logGroupName },
    } = event;

    this.#context = {
      ...this.#context,
      awsRegion,
      eventTime,
      logGroupName,
    };

    logger.appendKeys({
      awsRegion,
      logGroupName,
    });
  }

  @Lambda.contextCleaner()
  @logger.injectLambdaContext({ resetKeys: true })
  @parser({ envelope: EventBridgeEnvelope, schema: EventDetailSchema })
  async handler(event: EventDetail, _: Context) {
    this.#registerEventContext(event);

    const logGroup = await this.#fetchLogGroupInfo();
    const { retentionInDays } = logGroup;
    await this.#createDeleteSchedule(retentionInDays ?? 0);

    return true;
  }

  /**
   * Class method decorator to clean the context after the handler is done processing the event
   */
  public static contextCleaner(): HandlerMethodDecorator {
    return (_target, _propertyKey, descriptor) => {
      const originalMethod = descriptor.value as AsyncHandler<Handler>;
      descriptor.value = async function (
        this: Lambda,
        ...args: Parameters<typeof originalMethod>
      ) {
        const originalContext = structuredClone(this.#context);
        try {
          return await originalMethod.apply(this, args);
        } finally {
          this.#context = originalContext;
        }
      };
    };
  }
}

const lambda = new Lambda();
export const handler = lambda.handler.bind(lambda);
