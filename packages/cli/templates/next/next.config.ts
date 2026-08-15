import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Node-only packages the bundler must leave alone: the Postgres driver, the S3
  // client behind Filepack's optional object storage, and the Redis client behind
  // the optional multi-node transport.
  serverExternalPackages: ["@neondatabase/serverless", "ws", "@aws-sdk/client-s3", "ioredis"],
};

export default nextConfig;
