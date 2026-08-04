import { getStringFromEnv } from '@aws-lambda-powertools/commons/utils/env';
import { Logger } from '@aws-lambda-powertools/logger';
import { getParameter } from '@aws-lambda-powertools/parameters/ssm';
import type { Context } from 'aws-lambda';
import {
  type CloudWatchAlarmEvent,
  CloudWatchAlarmEventSchema,
} from './schemas/cloudwatch-alarm.js';

const logger = new Logger({ serviceName: 'slack-workflow-notifier' });
const slackWebhookParamName = getStringFromEnv({
  key: 'SLACK_WEBHOOK_PARAM_NAME',
});
const appName = getStringFromEnv({ key: 'APP_NAME' });

// Worst case: 4 attempts (1 initial + 3 retries) x 4s timeout = 16s, plus
// 1s + 2s + 4s backoff = 7s; 23s total, within the 30s Lambda timeout.
const REQUEST_TIMEOUT_MS = 4000;

interface SlackPayload {
  emoji: string;
  alarmName: string;
  alarmDescription: string;
  cloudWatchUrl: string;
  region: string;
  alarmTime: string;
  appName: string;
}

export const handler = async (
  event: CloudWatchAlarmEvent,
  context: Context
): Promise<void> => {
  logger.addContext(context);
  logger.logEventIfEnabled(event);

  // Parse and validate the event
  const parsedEvent = CloudWatchAlarmEventSchema.parse(event);

  // Only process ALARM state
  if (parsedEvent.alarmData.state.value !== 'ALARM') {
    logger.info('Skipping non-ALARM state', {
      state: parsedEvent.alarmData.state.value,
    });
    return;
  }

  // Fetch webhook URL (cached by Parameters utility)
  const webhookUrl = await getParameter(slackWebhookParamName, {
    decrypt: true,
    maxAge: 300,
  });

  if (!webhookUrl) {
    throw new Error('Webhook URL not available');
  }

  logger.info('Processing CloudWatch alarm', {
    alarmName: parsedEvent.alarmData.alarmName,
    state: parsedEvent.alarmData.state.value,
  });

  const payload: SlackPayload = {
    emoji: '🚨',
    alarmName: parsedEvent.alarmData.alarmName,
    alarmDescription: parsedEvent.alarmData.configuration.description,
    cloudWatchUrl: buildCloudWatchUrl(parsedEvent.alarmArn),
    region: parsedEvent.region,
    alarmTime: formatTimestamp(parsedEvent.alarmData.state.timestamp),
    appName,
  };

  await sendWithRetry(payload, webhookUrl);
};

function buildCloudWatchUrl(alarmArn: string): string {
  const arnParts = alarmArn.split(':');
  if (arnParts.length < 7) {
    throw new Error(`Invalid alarm ARN format: ${alarmArn}`);
  }
  const region = arnParts[3];
  const alarmName = arnParts[6];
  return `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#alarmsV2:alarm/${encodeURIComponent(alarmName)}`;
}

function formatTimestamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  return date
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, ' UTC');
}

async function sendWithRetry(
  payload: SlackPayload,
  url: string,
  maxRetries = 3
): Promise<void> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      logger.info('Successfully sent to Slack', { attempt });
      return;
    } catch (error) {
      if (attempt === maxRetries) {
        logger.error('Failed after retries', {
          error,
          totalAttempts: maxRetries,
        });
        throw error;
      }

      const backoffMs = 2 ** attempt * 1000;
      logger.warn('Retrying', { attempt: attempt + 1, backoffMs });
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}
