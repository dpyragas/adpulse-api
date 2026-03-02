import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const env = config.require("environment");

export const bucket = new aws.s3.BucketV2("uploads", {
  bucket: `adpulse-uploads-${env}`,
  forceDestroy: env === "dev",
  tags: { Project: "adpulse", Environment: env },
});

new aws.s3.BucketServerSideEncryptionConfigurationV2("uploads-encryption", {
  bucket: bucket.id,
  rules: [{
    applyServerSideEncryptionByDefault: {
      sseAlgorithm: "AES256",
    },
  }],
});

new aws.s3.BucketPublicAccessBlock("uploads-public-access", {
  bucket: bucket.id,
  blockPublicAcls: true,
  blockPublicPolicy: true,
  ignorePublicAcls: true,
  restrictPublicBuckets: true,
});
