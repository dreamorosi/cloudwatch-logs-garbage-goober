# Migration Plan: SNS Email → Slack Workflow Builder

## Overview
Replace SNS email notifications with Slack Workflow Builder webhook notifications for CloudWatch alarms. Process **ALARM state only**.

## Current State
- **3 CloudWatch Alarms**: DLQ Messages, EventHandler Errors, DeletionHandler Errors
- **Current**: SNS Topic → Email subscription
- **Target**: Lambda → Slack Workflow Builder webhook
- **Webhook URL**: `https://hooks.slack.com/triggers/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`
- **SSM Parameter**: `/slack-cloudwatch-alerts-webhook-url` (already created)

## Implementation Steps

### 1. Dependencies
```bash
npm install @aws-lambda-powertools/parameters @aws-lambda-powertools/parser
```

### 2. Configuration Updates

**`config.json`**:
```json
- "alertsEmailParameter": "/alerts-email"
+ "slackWebhookParameter": "/slack-cloudwatch-alerts-webhook-url"
```

**`src/types.ts`**:
```typescript
- /** SSM parameter name containing the alert email address */
- alertsEmailParameter: string;
+ /** SSM parameter name containing the Slack workflow webhook URL */
+ slackWebhookParameter: string;
```

### 3. Create CloudWatch Alarm Schema

**New file: `src/schemas/cloudwatch-alarm.ts`**
```typescript
import { z } from 'zod';

export const CloudWatchAlarmEventSchema = z.object({
  source: z.literal('aws.cloudwatch'),
  alarmArn: z.string(),
  accountId: z.string(),
  time: z.string(),
  region: z.string(),
  alarmData: z.object({
    alarmName: z.string(),
    state: z.object({
      value: z.enum(['ALARM', 'OK', 'INSUFFICIENT_DATA']),
      timestamp: z.string(),
      reason: z.string(),
    }),
    configuration: z.object({
      alarmDescription: z.string(),
      threshold: z.string().optional(),
    }),
  }),
});

export type CloudWatchAlarmEvent = z.infer<typeof CloudWatchAlarmEventSchema>;
```

### 4. Create Slack Notifier Lambda

**New file: `src/slack-workflow-notifier.ts`**
```typescript
import { getParameter } from '@aws-lambda-powertools/parameters/ssm';
import { parser } from '@aws-lambda-powertools/parser';
import { Logger } from '@aws-lambda-powertools/logger';
import type { Context } from 'aws-lambda';
import { CloudWatchAlarmEventSchema, type CloudWatchAlarmEvent } from './schemas/cloudwatch-alarm.js';

const logger = new Logger({ serviceName: 'slack-workflow-notifier' });

// Fetch webhook URL at module init
const webhookUrl = await getParameter(process.env.SLACK_WEBHOOK_PARAM_NAME!, {
  decrypt: true,
  maxAge: 300,
});

interface SlackPayload {
  emoji: string;
  alarmName: string;
  alarmDescription: string;
  cloudWatchUrl: string;
  region: string;
  alarmTime: string;
  appName: string;
}

class SlackNotifier {
  @parser({ schema: CloudWatchAlarmEventSchema })
  public async handler(event: CloudWatchAlarmEvent, _context: Context): Promise<void> {
    // Only process ALARM state
    if (event.alarmData.state.value !== 'ALARM') {
      logger.info('Skipping non-ALARM state', { state: event.alarmData.state.value });
      return;
    }

    if (!webhookUrl) {
      throw new Error('Webhook URL not available');
    }

    logger.info('Processing CloudWatch alarm', { 
      alarmName: event.alarmData.alarmName,
      state: event.alarmData.state.value 
    });

    const payload: SlackPayload = {
      emoji: '🚨',
      alarmName: event.alarmData.alarmName,
      alarmDescription: event.alarmData.configuration.alarmDescription,
      cloudWatchUrl: buildCloudWatchUrl(event.alarmArn),
      region: event.region,
      alarmTime: formatTimestamp(event.alarmData.state.timestamp),
      appName: process.env.APP_NAME!,
    };

    await sendWithRetry(payload, webhookUrl);
  }
}

function buildCloudWatchUrl(alarmArn: string): string {
  const arnParts = alarmArn.split(':');
  const region = arnParts[3];
  const alarmName = alarmArn.split(':').pop()!;
  return `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#alarmsV2:alarm/${encodeURIComponent(alarmName)}`;
}

function formatTimestamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

async function sendWithRetry(payload: SlackPayload, url: string, maxRetries = 3): Promise<void> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      logger.info('Successfully sent to Slack', { attempt });
      return;
    } catch (error) {
      if (attempt === maxRetries) {
        logger.error('Failed after retries', { error, totalAttempts: maxRetries });
        throw error;
      }

      const backoffMs = Math.pow(2, attempt) * 1000;
      logger.warn('Retrying', { attempt: attempt + 1, backoffMs });
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
}

const slackNotifier = new SlackNotifier();
export const handler = slackNotifier.handler.bind(slackNotifier);
```

### 5. Update CDK Stack

**`src/stack.ts` changes:**

**Remove imports:**
```typescript
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
```

**Add import:**
```typescript
import { LambdaAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { PolicyStatement, Effect, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
```

**Replace alerting section (lines ~298-312):**
```typescript
// Create Slack workflow notifier Lambda
const slackNotifier = this.#createTypeScriptFunction({
  id: 'slack-workflow-notifier',
  entry: 'slack-workflow-notifier.ts',
  environment: {
    SLACK_WEBHOOK_PARAM_NAME: slackWebhookParameter,
    APP_NAME: appName,
  },
  timeout: Duration.seconds(30),
  memorySize: 256,
});

// Grant SSM parameter read permissions
slackNotifier.addToRolePolicy(new PolicyStatement({
  effect: Effect.ALLOW,
  actions: ['ssm:GetParameter', 'kms:Decrypt'],
  resources: [
    `arn:aws:ssm:${this.region}:${this.account}:parameter${slackWebhookParameter}`,
  ],
}));

// Grant CloudWatch permission to invoke Lambda
slackNotifier.grantInvoke(new ServicePrincipal('cloudwatch.amazonaws.com'));

const alarmAction = new LambdaAction(slackNotifier);
```

### 6. Testing

**New file: `tests/slack-workflow-notifier.test.ts`**
- Mock `@aws-lambda-powertools/parameters/ssm`
- Mock `fetch` for webhook calls
- Test ALARM vs non-ALARM state handling
- Test parser validation
- Test retry logic
- Test URL generation and timestamp formatting

### 7. Deployment

```bash
# Verify SSM parameter exists
aws ssm get-parameter --name "/slack-cloudwatch-alerts-webhook-url" --with-decryption

# Deploy changes
cdk diff
cdk deploy

# Test by triggering an alarm
```

## Expected Slack Payload

```json
{
  "emoji": "🚨",
  "alarmName": "CWLogsGarbageGoober-DLQ-Messages",
  "alarmDescription": "Messages in DLQ indicate repeated deletion failures requiring investigation",
  "cloudWatchUrl": "https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#alarmsV2:alarm/CWLogsGarbageGoober-DLQ-Messages",
  "region": "us-east-1",
  "alarmTime": "2025-01-02 12:34:56 UTC",
  "appName": "CWLogsGarbageGoober"
}
```

## Files Changed

| File | Action | Lines |
|------|--------|-------|
| `config.json` | Update | 1 |
| `src/types.ts` | Update | 2 |
| `src/schemas/cloudwatch-alarm.ts` | New | ~25 |
| `src/slack-workflow-notifier.ts` | New | ~100 |
| `src/stack.ts` | Replace | ~20 |
| `tests/slack-workflow-notifier.test.ts` | New | ~150 |

## Key Features

✅ **ALARM Only**: Skips OK/INSUFFICIENT_DATA states  
✅ **Type Safety**: Custom Zod schema with Parser utility  
✅ **Caching**: Webhook URL cached at init, Parameters utility caching  
✅ **Retry Logic**: 3 attempts with exponential backoff  
✅ **IAM Security**: Explicit SSM parameter permissions  
✅ **ESM Pattern**: Top-level await for initialization  