declare global {
  namespace NodeJS {
    interface ProcessEnv {
      AWS_REGION: string;
    }
  }
}

export interface AppConfig {
  /** Name prefix for all AWS resources */
  appName: string;
  /** Log group name prefixes to match (e.g., "/aws/lambda/MyApp-") */
  logGroupPatterns: string[];
  /** Tags that must be present on the log group creation event */
  requiredTags: Record<string, string>;
  /** Days to wait after retention period before deleting */
  deletionDelayDays: number;
  /** SSM parameter name containing the alert email address */
  alertsEmailParameter: string;
}
