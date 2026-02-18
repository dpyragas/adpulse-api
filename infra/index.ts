import * as pulumi from "@pulumi/pulumi";
import { bucket } from "./s3";
import { queue, dlq } from "./sqs";

export const bucketName = bucket.bucket;
export const queueUrl = queue.url;
export const dlqUrl = dlq.url;
export const region = new pulumi.Config("aws").require("region");
