declare global {
  namespace NodeJS {
    interface ProcessEnv {
      AWS_REGION: string;
    }
  }
}

type AppConfig = {
  /** Name prefix for all AWS resources */
  appName: string;
  /** Log group name prefixes to match (e.g., "/aws/lambda/MyApp-") */
  logGroupPatterns: string[];
  /** Tags that must be present on the log group creation event */
  requiredTags: Record<string, string>;
  /** Days to wait after retention period before deleting */
  deletionDelayDays: number;
  /**
   * Retention period (in days) assumed for log groups that still have no
   * retention policy when the CreateLogGroup event is processed, i.e. log
   * groups set to never expire.
   */
  fallbackRetentionDays: number;
  /** SSM parameter name containing the Slack workflow webhook URL */
  slackWebhookParameter: string;
};

type SlackPayload = {
  emoji: string;
  alarmName: string;
  alarmDescription: string;
  cloudWatchUrl: string;
  region: string;
  alarmTime: string;
  appName: string;
};

export type { AppConfig, SlackPayload };
