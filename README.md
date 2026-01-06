<!-- markdownlint-disable MD033 -->

# CloudWatch Logs Garbage Goober

<p align="center">
  <img src="assets/logo.png" alt="CWLogsGarbageGoober Logo" width="200" />
</p>

Automated cleanup of CloudWatch Log Groups based on configurable patterns and tags.

## Overview

This CDK application automatically schedules and executes deletion of CloudWatch Log Groups that match configurable patterns. Instead of letting log groups accumulate indefinitely, this solution:

1. Detects when matching log groups are created (based on name patterns and tags)
2. Schedules their deletion based on retention settings plus a configurable delay
3. Deletes them automatically after the scheduled time

## Architecture

```txt
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│   CloudTrail    │────▶│  EventBridge │────▶│   SQS Queue     │
│ CreateLogGroup  │     │     Rule     │     │ (Event Buffer)  │
└─────────────────┘     └──────────────┘     └────────┬────────┘
                                                       │
                                                       ▼
                                              ┌─────────────────┐
                                              │  Event Handler  │
                                              │     Lambda      │
                                              │ (Batch Process) │
                                              └────────┬────────┘
                                                       │
                                                       ▼
                                              ┌─────────────────┐
                                              │   EventBridge   │
                                              │    Scheduler    │
                                              └────────┬────────┘
                                                       │
                                       (retention + deletionDelayDays)
                                                       │
                                                       ▼
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│   CloudWatch    │◀────│   Deletion   │◀────│   SQS Queue     │
│   Log Group     │     │   Handler    │     │   (Deletion)    │
│   (deleted)     │     │   Lambda     │     └─────────────────┘
└─────────────────┘     └──────────────┘              │
                                                       │ (on failure)
                                                       ▼
                                              ┌─────────────────┐
                                              │      DLQ        │
                                              └─────────────────┘
```

## Configuration

Create your configuration file from the template:

```bash
cp config.json.template config.json
```

Then edit `config.json` with your settings:

```json
{
  "appName": "CWLogsGarbageGoober",
  "logGroupPatterns": [
    "/aws/lambda/MyApp-",
    "/aws/lambda/TestService-"
  ],
  "requiredTags": {
    "Environment": "test"
  },
  "deletionDelayDays": 1,
  "slackWebhookParameter": "/slack-cloudwatch-alerts-webhook-url"
}
```

> **Note:** `config.json` is git-ignored to allow environment-specific configurations.

### Configuration Options

| Option                  | Description                                              | Default                                 |
| ----------------------- | -------------------------------------------------------- | --------------------------------------- |
| `appName`               | Prefix for all AWS resource names of this service        | `CWLogsGarbageGoober`                   |
| `logGroupPatterns`      | Log group name prefixes to match                         | Powertools e2e patterns                 |
| `requiredTags`          | Tags that must be present on CreateLogGroup event        | `Service: Powertools-for-AWS-e2e-tests` |
| `deletionDelayDays`     | Days to wait after retention period before deleting      | `1`                                     |
| `slackWebhookParameter` | SSM parameter name containing Slack workflow webhook URL | `/slack-cloudwatch-alerts-webhook-url`  |

### CDK Context Overrides

You can override any config option at deploy time using CDK context:

```bash
# Override app name
cdk deploy -c appName="MyLogGroupCleaner"

# Override log group patterns (JSON array)
cdk deploy -c logGroupPatterns='["/aws/lambda/MyApp-", "/custom/logs/"]'

# Override required tags (JSON object)
cdk deploy -c requiredTags='{"Environment":"staging","Team":"platform"}'

# Override deletion delay
cdk deploy -c deletionDelayDays=7
```

## Event Flow

1. **Detection**: An EventBridge Rule listens for `CreateLogGroup` CloudTrail events matching:
   - Log group names starting with patterns defined in `logGroupPatterns`
   - Tags matching all key-value pairs in `requiredTags`

2. **Buffering**: Events are sent to an SQS queue for throttling protection and batch processing

3. **Scheduling**: The Event Handler Lambda processes SQS messages in batches (up to 10 at once):
   - Fetches each log group's retention settings
   - Creates EventBridge Scheduler one-time schedules to fire after `retention + deletionDelayDays` (in UTC)
   - Schedules auto-delete after execution
   - Failed events are retried up to 3 times before going to DLQ

4. **Deletion**: When schedules fire:
   - Messages are sent to the SQS deletion queue
   - The Deletion Handler Lambda processes messages in batches
   - Log groups are deleted via the CloudWatch Logs API
   - Already-deleted log groups are handled gracefully (idempotent)

5. **Failure Handling**:
   - Failed deletions are retried up to 3 times
   - Persistent failures go to the Dead Letter Queue (DLQ)
   - CloudWatch Alarms notify via Slack when issues occur

## Prerequisites

- Node.js v22.18.0 or later
- AWS CLI configured with appropriate credentials
- A Slack Workflow Builder webhook URL stored in SSM Parameter

Create the SSM parameter before deploying:

```bash
aws ssm put-parameter \
  --name "/slack-cloudwatch-alerts-webhook-url" \
  --type "SecureString" \
  --value "https://hooks.slack.com/triggers/YOUR_WEBHOOK_URL" \
  --description "Slack Workflow Builder webhook for CloudWatch alarm notifications"
```

## Deployment

```bash
# Install dependencies
npm ci

# Deploy the stack
npm run cdk deploy
```

After deployment, **configure your Slack Workflow Builder** to receive the webhook notifications with the expected payload format.

## Throttling Protection

The system includes built-in protection against AWS API throttling during high-volume events:

- **SQS Event Buffering**: EventBridge events are queued in SQS before Lambda processing
- **Batch Processing**: Lambda processes up to 10 events per invocation using AWS Lambda Powertools
- **Controlled Concurrency**: Maximum 10 concurrent Lambda executions prevent overwhelming AWS APIs
- **Adaptive Retry**: AWS SDK configured with adaptive retry mode and exponential backoff
- **Partial Failure Handling**: Failed events are retried individually without affecting successful ones
- **Dead Letter Queue**: Persistent failures are captured for investigation

This architecture prevents the "thundering herd" scenario that can occur during large-scale log group creation events.

## Monitoring & Alerting

The stack includes CloudWatch Alarms that send Slack notifications:

| Alarm                              | Trigger                   | Description                                         |
| ---------------------------------- | ------------------------- | --------------------------------------------------- |
| `{appName}-Rule-FailedInvocations` | >= 1 failed invocation    | EventBridge rule failed to deliver events to SQS    |
| `{appName}-DLQ-Messages`           | >= 1 message in DLQ       | Permanent deletion failures requiring investigation |
| `{appName}-EventHandler-Errors`    | >= 1 error in 5 min       | Event handler Lambda errors                         |
| `{appName}-DeletionHandler-Errors` | >= 1 error in 5 min       | Deletion handler Lambda errors                      |
| `{appName}-EventQueue-Depth`       | >= 50 messages for 10 min | Event processing queue backlog                      |
| `{appName}-EventQueue-MessageAge`  | >= 300 seconds for 10 min | Event processing delays                             |

### Slack Payload Format

The Slack Workflow Builder webhook receives notifications with this payload:

```json
{
  "emoji": "🚨",
  "alarmName": "CWLogsGarbageGoober-DLQ-Messages",
  "alarmDescription": "Messages in DLQ indicate repeated deletion failures requiring investigation",
  "cloudWatchUrl": "https://eu-west-1.console.aws.amazon.com/cloudwatch/home?region=eu-west-1#alarmsV2:alarm/CWLogsGarbageGoober-DLQ-Messages",
  "region": "eu-west-1",
  "alarmTime": "2025-01-02 14:28:58 UTC",
  "appName": "CWLogsGarbageGoober"
}
```

## Development

```bash
# Run tests (watch mode)
npm test

# Run tests once with coverage
npm test -- run --coverage

# Lint and format
npm run lint:fix

# Synthesize CloudFormation template
npm run cdk synth

# Compare deployed stack with current state
npm run cdk diff
```

## AWS Resources Created

| Resource          | Name Pattern                        | Purpose                                            |
| ----------------- | ----------------------------------- | -------------------------------------------------- |
| Lambda            | `{appName}-event-handler`           | Processes CreateLogGroup events in batches         |
| Lambda            | `{appName}-deletion-handler`        | Deletes log groups from SQS messages               |
| Lambda            | `{appName}-slack-workflow-notifier` | Sends alarm notifications to Slack                 |
| SQS Queue         | `{appName}-event-processing-queue`  | Buffers CreateLogGroup events for batch processing |
| SQS Queue         | `{appName}-deletion-queue`          | Queues deletion tasks                              |
| SQS Queue         | `{appName}-deletion-dlq`            | Dead letter queue for failed deletions             |
| EventBridge Rule  | `{appName}-Rule`                    | Captures CreateLogGroup events                     |
| IAM Role          | `{appName}-publish-to-queue-role`   | Allows Scheduler to send to SQS                    |
| CloudWatch Alarms | `{appName}-*`                       | Operational monitoring                             |

## License

MIT-0
