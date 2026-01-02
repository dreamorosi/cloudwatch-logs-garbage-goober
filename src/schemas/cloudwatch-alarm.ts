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
    previousState: z
      .object({
        value: z.enum(['ALARM', 'OK', 'INSUFFICIENT_DATA']),
        reason: z.string(),
        reasonData: z.string().optional(),
        timestamp: z.string(),
      })
      .optional(),
    configuration: z.object({
      description: z.string(),
      metrics: z.array(z.any()).optional(),
    }),
  }),
});

export type CloudWatchAlarmEvent = z.infer<typeof CloudWatchAlarmEventSchema>;
