import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const env = config.require("environment");

export const dlq = new aws.sqs.Queue("analysis-dlq", {
  name: `adpulse-analysis-dlq-${env}`,
  messageRetentionSeconds: 1_209_600, // 14 days
  tags: { Project: "adpulse", Environment: env },
});

export const queue = new aws.sqs.Queue("analysis-queue", {
  name: `adpulse-analysis-${env}`,
  visibilityTimeoutSeconds: 120,      // matches analysis.worker.ts
  messageRetentionSeconds: 345_600,   // 4 days
  redrivePolicy: dlq.arn.apply(arn => JSON.stringify({
    deadLetterTargetArn: arn,
    maxReceiveCount: 3,
  })),
  tags: { Project: "adpulse", Environment: env },
});
